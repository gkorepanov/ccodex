use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use clap::Parser;
use clap::Subcommand;
use codex_app_server_protocol::{JSONRPCMessage, ServerNotification, ServerRequest};
use codex_app_server_transport::{
    CHANNEL_CAPACITY, ConnectionId, OutgoingError, OutgoingMessage, OutgoingResponse,
    QueuedOutgoingMessage, RemoteControlPolicy, RemoteControlStartConfig, RemoteControlStartupMode,
    TransportEvent, start_remote_control,
};
use codex_core::config::Config;
use codex_core::resolve_installation_id;
use codex_login::AuthManager;
use futures::{SinkExt, StreamExt};
use tokio::net::UnixStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
struct Args {
    #[command(subcommand)]
    command: Option<Command>,
    #[arg(long)]
    socket: Option<PathBuf>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Parse a shell script with the exact Codex command-action parser.
    ParseCommand,
}

struct ClientBridge {
    to_gateway: mpsc::Sender<String>,
    shutdown: CancellationToken,
}

#[cfg(unix)]
async fn shutdown_signal() -> std::io::Result<()> {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::select! {
        result = tokio::signal::ctrl_c() => result,
        _ = terminate.recv() => Ok(()),
    }
}

#[cfg(not(unix))]
async fn shutdown_signal() -> std::io::Result<()> {
    tokio::signal::ctrl_c().await
}

fn outgoing_message(message: JSONRPCMessage) -> Result<OutgoingMessage> {
    Ok(match message {
        JSONRPCMessage::Request(request) => OutgoingMessage::Request(
            serde_json::from_value::<ServerRequest>(serde_json::to_value(request)?)
                .context("gateway emitted an unknown server request")?,
        ),
        JSONRPCMessage::Notification(notification) => OutgoingMessage::AppServerNotification(
            serde_json::from_value::<ServerNotification>(serde_json::to_value(notification)?)
                .context("gateway emitted an unknown server notification")?,
        ),
        JSONRPCMessage::Response(response) => OutgoingMessage::Response(OutgoingResponse {
            id: response.id,
            result: response.result,
        }),
        JSONRPCMessage::Error(error) => OutgoingMessage::Error(OutgoingError {
            id: error.id,
            error: error.error,
        }),
    })
}

async fn bridge_client(
    socket: PathBuf,
    mut to_gateway: mpsc::Receiver<String>,
    remote_writer: mpsc::Sender<QueuedOutgoingMessage>,
    shutdown: CancellationToken,
) -> Result<()> {
    let stream = UnixStream::connect(&socket)
        .await
        .with_context(|| format!("connect hybrid gateway {}", socket.display()))?;
    let (gateway, _) = tokio_tungstenite::client_async("ws://localhost/rpc", stream)
        .await
        .context("upgrade hybrid gateway websocket")?;
    let (mut gateway_writer, mut gateway_reader) = gateway.split();

    loop {
        tokio::select! {
            _ = shutdown.cancelled() => break,
            incoming = to_gateway.recv() => {
                let Some(incoming) = incoming else { break };
                gateway_writer.send(Message::Text(incoming.into())).await
                    .context("write remote RPC to hybrid gateway")?;
            }
            outgoing = gateway_reader.next() => {
                let Some(outgoing) = outgoing else { break };
                match outgoing.context("read hybrid gateway RPC")? {
                    Message::Text(text) => {
                        let rpc: JSONRPCMessage = serde_json::from_str(text.as_str())
                            .context("decode hybrid gateway RPC")?;
                        remote_writer.send(QueuedOutgoingMessage::new(outgoing_message(rpc)?)).await
                            .context("remote-control client closed")?;
                    }
                    Message::Ping(payload) => gateway_writer.send(Message::Pong(payload)).await
                        .context("write gateway pong")?,
                    Message::Close(_) => break,
                    Message::Binary(_) | Message::Pong(_) | Message::Frame(_) => {}
                }
            }
        }
    }

    Ok(())
}

async fn run(args: Args) -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();

    let config = Config::load_with_cli_overrides(Vec::new())
        .await
        .context("load Codex config")?;
    let state_db = codex_core::init_state_db(&config)
        .await
        .context("Codex sqlite state DB is required for remote control")?;
    let installation_id = resolve_installation_id(&config.codex_home)
        .await
        .context("resolve Codex installation id")?;
    let policy = if config
        .config_layer_stack
        .requirements()
        .allow_remote_control
        .as_ref()
        .is_some_and(|requirement| !requirement.value)
    {
        RemoteControlPolicy::DisabledByRequirements
    } else {
        RemoteControlPolicy::Allowed
    };
    if policy == RemoteControlPolicy::DisabledByRequirements {
        bail!("remote control is disabled by managed requirements");
    }
    let auth_manager = AuthManager::shared_from_config(&config, false).await;
    let shutdown = CancellationToken::new();
    let (transport_tx, mut transport_rx) = mpsc::channel(CHANNEL_CAPACITY);
    let (remote_task, remote_handle) = start_remote_control(
        RemoteControlStartConfig {
            remote_control_url: config.chatgpt_base_url.clone(),
            installation_id,
            policy,
        },
        Some(state_db),
        auth_manager,
        transport_tx,
        shutdown.clone(),
        None,
        RemoteControlStartupMode::EnabledEphemeral,
    )
    .await
    .context("start upstream Codex remote-control transport")?;

    let mut status_rx = remote_handle.status_receiver();
    let status_task = tokio::spawn(async move {
        println!(
            "{}",
            serde_json::json!({"type":"status","params":*status_rx.borrow()})
        );
        println!("{}", serde_json::json!({"type":"ready"}));
        while status_rx.changed().await.is_ok() {
            println!(
                "{}",
                serde_json::json!({"type":"status","params":*status_rx.borrow()})
            );
        }
    });

    let socket = args
        .socket
        .context("--socket is required for remote relay mode")?;
    let mut clients = HashMap::<ConnectionId, ClientBridge>::new();
    let signal = shutdown_signal();
    tokio::pin!(signal);
    loop {
        tokio::select! {
            signal = &mut signal => {
                signal.context("wait for shutdown signal")?;
                break;
            }
            event = transport_rx.recv() => {
                let Some(event) = event else { break };
                match event {
                    TransportEvent::ConnectionOpened { connection_id, writer, disconnect_sender, .. } => {
                        let (to_gateway, from_remote) = mpsc::channel(CHANNEL_CAPACITY);
                        let client_shutdown = CancellationToken::new();
                        let bridge_shutdown = client_shutdown.clone();
                        let socket = socket.clone();
                        tokio::spawn(async move {
                            let result = bridge_client(
                                socket,
                                from_remote,
                                writer,
                                bridge_shutdown,
                            ).await;
                            if let Some(disconnect_sender) = disconnect_sender {
                                disconnect_sender.cancel();
                            }
                            if let Err(error) = result {
                                warn!(%connection_id, %error, "remote client bridge failed");
                            }
                        });
                        clients.insert(connection_id, ClientBridge { to_gateway, shutdown: client_shutdown });
                        info!(%connection_id, "remote client connected to hybrid gateway");
                    }
                    TransportEvent::IncomingMessage { connection_id, message } => {
                        let Some(client) = clients.get(&connection_id) else {
                            warn!(%connection_id, "dropping RPC for unknown remote client");
                            continue;
                        };
                        let payload = serde_json::to_string(&message)?;
                        if client.to_gateway.send(payload).await.is_err() {
                            warn!(%connection_id, "hybrid gateway bridge closed");
                        }
                    }
                    TransportEvent::ConnectionClosed { connection_id } => {
                        if let Some(client) = clients.remove(&connection_id) {
                            client.shutdown.cancel();
                        }
                        info!(%connection_id, "remote client disconnected from hybrid gateway");
                    }
                }
            }
        }
    }

    shutdown.cancel();
    for client in clients.into_values() {
        client.shutdown.cancel();
    }
    remote_task.await.context("join remote-control transport")?;
    status_task.abort();
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    if matches!(args.command.as_ref(), Some(Command::ParseCommand)) {
        let mut script = String::new();
        std::io::stdin().read_to_string(&mut script)?;
        let command = vec!["bash".to_string(), "-lc".to_string(), script];
        println!(
            "{}",
            serde_json::to_string(&codex_shell_command::parse_command::parse_command(&command))?
        );
        return Ok(());
    }
    if !args
        .socket
        .as_ref()
        .is_some_and(|socket| socket.is_absolute())
    {
        bail!("--socket must be absolute");
    }
    run(args).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_app_server_protocol::{
        JSONRPCError, JSONRPCErrorError, JSONRPCNotification, JSONRPCResponse, RequestId,
    };
    use tokio::net::UnixListener;
    use tokio_tungstenite::accept_async;

    #[test]
    fn converts_response_and_error_without_typed_method_loss() {
        let response = outgoing_message(JSONRPCMessage::Response(JSONRPCResponse {
            id: RequestId::Integer(7),
            result: serde_json::json!({"ok": true}),
        }))
        .unwrap();
        assert_eq!(
            serde_json::to_value(response).unwrap(),
            serde_json::json!({"id":7,"result":{"ok":true}})
        );

        let error = outgoing_message(JSONRPCMessage::Error(JSONRPCError {
            id: RequestId::String("x".into()),
            error: JSONRPCErrorError {
                code: -32602,
                message: "bad".into(),
                data: None,
            },
        }))
        .unwrap();
        assert_eq!(
            serde_json::to_value(error).unwrap(),
            serde_json::json!({"id":"x","error":{"code":-32602,"message":"bad"}})
        );
    }

    #[test]
    fn converts_known_server_notification() {
        let notification = JSONRPCMessage::Notification(JSONRPCNotification {
            method: "thread/name/updated".into(),
            params: Some(
                serde_json::json!({"threadId":"019f6232-67f2-7db2-993b-b89f56d2dc97","threadName":"mobile"}),
            ),
        });
        let outgoing = outgoing_message(notification).unwrap();
        assert_eq!(
            serde_json::to_value(outgoing).unwrap()["method"],
            "thread/name/updated"
        );
    }

    #[test]
    fn parses_stock_capture_commands_into_native_actions() {
        let list_script =
            "rg --files ~/.ccodex/current/node_modules/@gkorepanov/ccodex/dist | sed -n '1,240p'";
        let list = codex_shell_command::parse_command::parse_command(&[
            "bash".to_string(),
            "-lc".to_string(),
            list_script.to_string(),
        ]);
        assert_eq!(
            serde_json::to_value(list).unwrap(),
            serde_json::json!([{
                "type": "list_files",
                "cmd": "rg --files '~/.ccodex/current/node_modules/@gkorepanov/ccodex/dist'",
                "path": "ccodex"
            }])
        );

        let search_script = "rg -n -C 2 'forkThread|async fork|shouldFork' ~/.ccodex/current/node_modules/@gkorepanov/ccodex/dist/handoff ~/.ccodex/current/node_modules/@gkorepanov/ccodex/dist/claude --glob '*.js' | sed -n '1,300p'";
        let search = codex_shell_command::parse_command::parse_command(&[
            "bash".to_string(),
            "-lc".to_string(),
            search_script.to_string(),
        ]);
        assert_eq!(
            serde_json::to_value(search).unwrap(),
            serde_json::json!([{
                "type": "search",
                "cmd": "rg -n -C 2 'forkThread|async fork|shouldFork' '~/.ccodex/current/node_modules/@gkorepanov/ccodex/dist/handoff' '~/.ccodex/current/node_modules/@gkorepanov/ccodex/dist/claude' --glob '*.js'",
                "query": "forkThread|async fork|shouldFork",
                "path": "handoff"
            }])
        );
    }

    #[tokio::test]
    async fn bridges_json_rpc_over_a_unix_websocket() {
        let directory = tempfile::tempdir().unwrap();
        let socket = directory.path().join("gateway.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut websocket = accept_async(stream).await.unwrap();
            let incoming = websocket
                .next()
                .await
                .unwrap()
                .unwrap()
                .into_text()
                .unwrap();
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&incoming).unwrap()["method"],
                "turn/start"
            );
            websocket
                .send(Message::Text(
                    serde_json::json!({
                        "method": "thread/name/updated",
                        "params": {
                            "threadId": "019f6232-67f2-7db2-993b-b89f56d2dc97",
                            "threadName": "mobile"
                        }
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .unwrap();
            websocket.close(None).await.unwrap();
        });
        let (to_gateway, from_remote) = mpsc::channel(1);
        let (remote_writer, mut outgoing) = mpsc::channel(1);
        let shutdown = CancellationToken::new();
        let bridge = tokio::spawn(bridge_client(
            socket,
            from_remote,
            remote_writer,
            shutdown.clone(),
        ));
        to_gateway
            .send(serde_json::json!({"id":1,"method":"turn/start","params":{}}).to_string())
            .await
            .unwrap();
        let outgoing = outgoing.recv().await.unwrap();
        assert_eq!(
            serde_json::to_value(outgoing.message).unwrap()["method"],
            "thread/name/updated"
        );
        server.await.unwrap();
        shutdown.cancel();
        bridge.await.unwrap().unwrap();
    }
}
