import { createTwoFilesPatch } from "diff";
import type { FileUpdateChange } from "../codex/generated/v2/FileUpdateChange.js";
import { snapshotFile, type FileSnapshot } from "./fileSnapshots.js";

interface PartialString {
  readonly value: string;
  readonly complete: boolean;
}

class StreamingJsonObject {
  private depth = 0;
  private expectKey = false;
  private expectValue = false;
  private currentKey: string | undefined;
  private stringRole: "key" | "value" | "other" | undefined;
  private stringKey: string | undefined;
  private stringValue = "";
  private escaped = false;
  private unicode: string | undefined;
  private scalar = "";
  private readonly strings = new Map<string, PartialString>();
  private readonly scalars = new Map<string, string>();

  public push(chunk: string): void {
    for (const character of chunk) this.pushCharacter(character);
    if (this.stringRole === "value" && this.stringKey) {
      this.strings.set(this.stringKey, { value: this.stringValue, complete: false });
    }
  }

  public string(key: string): PartialString | undefined {
    return this.strings.get(key);
  }

  public boolean(key: string): boolean {
    return this.scalars.get(key) === "true";
  }

  private pushCharacter(character: string): void {
    if (this.stringRole) {
      this.pushStringCharacter(character);
      return;
    }
    if (this.scalar) {
      if (this.depth === 1 && (character === "," || character === "}")) {
        if (this.currentKey) this.scalars.set(this.currentKey, this.scalar.trim());
        this.scalar = "";
        this.currentKey = undefined;
        this.expectValue = false;
        if (character === ",") this.expectKey = true;
        else this.depth -= 1;
      } else {
        this.scalar += character;
      }
      return;
    }
    if (character === "{") {
      if (this.depth === 1 && this.expectValue) {
        this.currentKey = undefined;
        this.expectValue = false;
      }
      this.depth += 1;
      if (this.depth === 1) this.expectKey = true;
      return;
    }
    if (character === "[") {
      if (this.depth === 1 && this.expectValue) {
        this.currentKey = undefined;
        this.expectValue = false;
      }
      this.depth += 1;
      return;
    }
    if (character === "}" || character === "]") {
      this.depth -= 1;
      return;
    }
    if (character === "," && this.depth === 1) {
      this.currentKey = undefined;
      this.expectValue = false;
      this.expectKey = true;
      return;
    }
    if (character === ":" && this.depth === 1 && this.currentKey) {
      this.expectValue = true;
      return;
    }
    if (character === "\"") {
      this.stringRole = this.depth === 1 && this.expectKey ? "key"
        : this.depth === 1 && this.expectValue ? "value" : "other";
      this.stringKey = this.stringRole === "value" ? this.currentKey : undefined;
      this.stringValue = "";
      return;
    }
    if (this.depth === 1 && this.expectValue && !/\s/u.test(character)) {
      this.scalar = character;
    }
  }

  private pushStringCharacter(character: string): void {
    if (this.unicode !== undefined) {
      this.unicode += character;
      if (this.unicode.length === 4) {
        this.stringValue += String.fromCharCode(Number.parseInt(this.unicode, 16));
        this.unicode = undefined;
      }
      return;
    }
    if (this.escaped) {
      this.escaped = false;
      if (character === "u") {
        this.unicode = "";
        return;
      }
      this.stringValue += ({
        "\"": "\"", "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t",
      } as Record<string, string>)[character] ?? character;
      return;
    }
    if (character === "\\") {
      this.escaped = true;
      return;
    }
    if (character !== "\"") {
      this.stringValue += character;
      return;
    }
    if (this.stringRole === "key") {
      this.currentKey = this.stringValue;
      this.expectKey = false;
    } else if (this.stringRole === "value" && this.stringKey) {
      this.strings.set(this.stringKey, { value: this.stringValue, complete: true });
      this.currentKey = undefined;
      this.expectValue = false;
    }
    this.stringRole = undefined;
    this.stringKey = undefined;
    this.stringValue = "";
  }
}

const previewIntervalMs = 500;

export class StreamingFileChangePreview {
  private readonly input = new StreamingJsonObject();
  private snapshot: FileSnapshot | undefined;
  private lastDiff: string | undefined;
  private lastSentAt = 0;

  public constructor(
    private readonly toolName: string,
    private readonly cwd: string,
    private readonly now: () => number = Date.now,
  ) {}

  public async push(delta: string): Promise<FileUpdateChange | undefined> {
    this.input.push(delta);
    return this.change(false);
  }

  public async finish(): Promise<FileUpdateChange | undefined> {
    return this.change(true);
  }

  private async change(force: boolean): Promise<FileUpdateChange | undefined> {
    const timestamp = this.now();
    if (!force && this.lastSentAt && timestamp - this.lastSentAt < previewIntervalMs) return undefined;
    const path = this.input.string("file_path") ?? this.input.string("path");
    if (!path?.complete) return undefined;
    if (!this.snapshot || this.snapshot.path !== path.value) {
      this.snapshot = await snapshotFile(this.toolName, { file_path: path.value }, this.cwd);
    }
    if (!this.snapshot) return undefined;
    const change = this.toolName === "Write" ? this.writeChange() : this.toolName === "Edit" ? this.editChange() : undefined;
    if (!change || change.diff === this.lastDiff) return undefined;
    this.lastDiff = change.diff;
    this.lastSentAt = timestamp;
    return change;
  }

  private writeChange(): FileUpdateChange | undefined {
    const content = this.input.string("content");
    if (!content) return undefined;
    if (this.snapshot!.content === null) {
      return { path: this.snapshot!.path, kind: { type: "add" }, diff: content.value };
    }
    return {
      path: this.snapshot!.path,
      kind: { type: "update", move_path: null },
      diff: createTwoFilesPatch(
        this.snapshot!.path, this.snapshot!.path, this.snapshot!.content, content.value, "", "",
      ),
    };
  }

  private editChange(): FileUpdateChange | undefined {
    const before = this.snapshot!.content;
    const oldString = this.input.string("old_string");
    const newString = this.input.string("new_string");
    if (before === null || !oldString?.complete || !oldString.value || !newString || !before.includes(oldString.value)) {
      return undefined;
    }
    const after = this.input.boolean("replace_all")
      ? before.split(oldString.value).join(newString.value)
      : before.replace(oldString.value, newString.value);
    return {
      path: this.snapshot!.path,
      kind: { type: "update", move_path: null },
      diff: createTwoFilesPatch(this.snapshot!.path, this.snapshot!.path, before, after, "", ""),
    };
  }
}
