#!/usr/bin/env python3
"""在 bom-admin 上断言 startship 本地 destRel 硬链，并抽查 ext / 飞书现状。

用法（生产机）：
  python3 assert.py
环境变量：
  BOM_HOST_STORE  本地根，默认 /data2/soft_bom
  STARTSHIP_PRODUCT  产品名，默认 startship
"""
import hashlib
import json
import os
import subprocess
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = Path(os.environ.get("BOM_HOST_STORE", "/data2/soft_bom"))
PRODUCT_NAME = os.environ.get("STARTSHIP_PRODUCT", "startship")
EXPECTED = json.loads((HERE / "expected.json").read_text(encoding="utf-8"))
ALPHA_MD5 = "bd451c5b3a483a573ddee76344c9fe0d"
fails = []


def fail(msg):
    fails.append(msg)
    print("FAIL", msg)


def ok(msg):
    print("OK  ", msg)


def psql(sql):
    p = subprocess.run(
        [
            "docker",
            "exec",
            "-i",
            "supabase-db",
            "psql",
            "-U",
            "postgres",
            "-d",
            "postgres",
            "-At",
            "-c",
            sql,
        ],
        text=True,
        capture_output=True,
    )
    if p.returncode != 0:
        raise RuntimeError(p.stderr)
    return p.stdout.strip()


def md5_file(p: Path) -> str:
    h = hashlib.md5()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


product_id = psql("SELECT id FROM products WHERE name='%s' ORDER BY created_at DESC LIMIT 1;" % PRODUCT_NAME.replace("'", "''"))
if not product_id:
    raise SystemExit("product not found: %s" % PRODUCT_NAME)
print("product", PRODUCT_NAME, product_id)

print("=== local disk ===")
inode_by_path = {}
for item in EXPECTED["expectedLocal"]:
    rel = item["path"]
    abs_p = ROOT / rel
    if not abs_p.is_file():
        fail("missing file %s" % rel)
        continue
    got = md5_file(abs_p)
    if got != item["md5"]:
        fail("md5 %s got=%s want=%s" % (rel, got, item["md5"]))
        continue
    st = abs_p.stat()
    inode_by_path[rel] = (st.st_ino, st.st_nlink)
    ok("%s md5=%s nlink=%s ino=%s" % (rel, got, st.st_nlink, st.st_ino))

for item in EXPECTED["expectedLocal"]:
    other = item.get("sameInodeAs")
    if not other:
        continue
    a = inode_by_path.get(item["path"])
    b = inode_by_path.get(other)
    if not a or not b:
        continue
    if a[0] != b[0]:
        fail("inode %s != %s (%s vs %s)" % (item["path"], other, a[0], b[0]))
    else:
        ok("same inode %s <-> %s" % (item["path"], other))

alpha = "v1.0/Raptor/same.sh"
if alpha in inode_by_path and inode_by_path[alpha][1] < 3:
    fail("%s nlink=%s expected >=3" % (alpha, inode_by_path[alpha][1]))
elif alpha in inode_by_path:
    ok("%s nlink=%s >=3" % (alpha, inode_by_path[alpha][1]))

print("=== local_file index ===")
for item in EXPECTED["expectedLocal"]:
    rel = item["path"]
    row = psql("SELECT md5 FROM local_file WHERE path='%s';" % rel.replace("'", "''"))
    if not row:
        fail("local_file missing %s" % rel)
    elif row.lower() != item["md5"]:
        fail("local_file md5 %s %s != %s" % (rel, row, item["md5"]))
    else:
        ok("local_file %s" % rel)

print("=== bom_rows local/feishu/ext status ===")
rows = psql(
    """SELECT b.name, br.bom_row->>'组件ID', br.bom_row->>'MD5', br.status->>'local',
              COALESCE(br.status->>'feishu','?'), COALESCE(br.status->>'ext','?'),
              COALESCE(br.status->>'feishu_file_token','')
       FROM bom_rows br JOIN bom_batches b ON b.id=br.batch_id
       WHERE b.product_id='%s'
       ORDER BY b.name, br.sort_order;"""
    % product_id
)
print(rows)
alpha_tokens = set()
for line in rows.splitlines():
    parts = line.split("|")
    if len(parts) < 6:
        continue
    if parts[3] not in ("verified_ok", "local_found"):
        fail("row local status %s" % line)
    if parts[4] != "present":
        fail("feishu status %s" % line)
    if parts[5] != "synced_or_skipped":
        fail("ext status %s" % line)
    if (parts[2] or "").lower() == ALPHA_MD5 and parts[6]:
        alpha_tokens.add(parts[6])
if alpha_tokens and len(alpha_tokens) != 1:
    fail("alpha MD5 should reuse one feishu token, got %s" % sorted(alpha_tokens))
elif alpha_tokens:
    ok("alpha MD5 feishu token reused (%s)" % next(iter(alpha_tokens)))

print("=== ext storage ===")
raw = psql("SELECT value::text FROM system_settings WHERE key='artifactory_config';")
cfg = json.loads(raw)
ext_base = (cfg.get("artifactoryExtBaseUrl") or "").rstrip("/")
ext_key = (cfg.get("artifactoryExtApiKey") or "").strip()
origin = ext_base.split("/artifactory")[0] if "/artifactory" in ext_base else ext_base
repo = "startship-packages"
list_url = "%s/artifactory/api/storage/%s?list&deep=1&listFolders=0" % (origin, repo)
req = urllib.request.Request(list_url, headers={"X-JFrog-Art-Api": ext_key})
with urllib.request.urlopen(req, timeout=60) as resp:
    listing = json.loads(resp.read().decode())
ext_files = {str(x.get("uri") or "").lstrip("/") for x in listing.get("files") or []}
print("ext file count", len(ext_files))
for rel in EXPECTED["ext"]["mustHavePaths"]:
    if rel in ext_files:
        ok("ext %s" % rel)
    else:
        fail("ext missing %s" % rel)

print("=== summary ===")
if fails:
    print("FAILED", len(fails))
    for f in fails:
        print(" -", f)
    raise SystemExit(1)
print("ALL_PASS")
