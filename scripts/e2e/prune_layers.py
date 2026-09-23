"""Podman 3.4 (rootless) leaks the layers of interrupted builds and removals: no image or container references them,
and no podman command removes them. Deletes such layers older than an hour. Run under `podman unshare`."""
import fcntl, json, os, shutil, time

root = os.path.expanduser("~/.local/share/containers/storage")
locks = [open(f"{root}/{name}", "a") for name in ("overlay-layers/layers.lock", "overlay-images/images.lock", "overlay-containers/containers.lock")]
for lock in locks: fcntl.lockf(lock, fcntl.LOCK_EX)
layers = json.load(open(f"{root}/overlay-layers/layers.json"))
images = json.load(open(f"{root}/overlay-images/images.json"))
containers = json.load(open(f"{root}/overlay-containers/containers.json"))
parent = {layer["id"]: layer.get("parent") for layer in layers}
used = set()
for top in [i["layer"] for i in images] + [m for i in images for m in i.get("mapped-layers") or []] + [c["layer"] for c in containers]:
    while top and top not in used:
        used.add(top)
        top = parent.get(top)
# A layer a concurrent build just committed is referenced only once its image is written: leave recent ones alone.
cutoff = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - 3600))
leaked = [layer["id"] for layer in layers if layer["id"] not in used and layer.get("created", "")[:19] < cutoff]
if leaked:
    tmp = f"{root}/overlay-layers/layers.json.tmp"
    json.dump([layer for layer in layers if layer["id"] not in leaked], open(tmp, "w"))
    os.replace(tmp, f"{root}/overlay-layers/layers.json")
    for layer_id in leaked:
        link = f"{root}/overlay/{layer_id}/link"
        if os.path.exists(link) and os.path.islink(f"{root}/overlay/l/{open(link).read().strip()}"):
            os.unlink(f"{root}/overlay/l/{open(link).read().strip()}")
        shutil.rmtree(f"{root}/overlay/{layer_id}", ignore_errors=True)
        if os.path.exists(f"{root}/overlay-layers/{layer_id}.tar-split.gz"): os.unlink(f"{root}/overlay-layers/{layer_id}.tar-split.gz")
    print(f"pruned {len(leaked)} leaked podman layers")
