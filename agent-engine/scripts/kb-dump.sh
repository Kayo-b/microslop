#!/usr/bin/env bash
# Downloads the latest live OSRS cache from OpenRS2 (unless data/cache already has one) and
# dumps definitions + object placements to data/kb-raw/ with the Java kb-dumper.
#
# Env:
#   OPENRS2_CACHE_ID  pin a specific cache id (default: newest live oldschool cache)
#   JAVA_HOME         JDK 17+ (Microbot's Gradle daemon requires 17; `mise where java@temurin-17`)
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/.." && pwd)"
cache_dir="$here/data/cache"
out_dir="$here/data/kb-raw"
ua="microbot-agent-engine-kb/0.1"

if [[ ! -f "$cache_dir/cache/main_file_cache.dat2" ]]; then
  id="${OPENRS2_CACHE_ID:-}"
  if [[ -z "$id" ]]; then
    id="$(curl -sf -A "$ua" https://archive.openrs2.org/caches.json | node -e '
      let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
        const live = JSON.parse(s).filter(c => c.game === "oldschool" && c.environment === "live" && c.timestamp);
        live.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        process.stdout.write(String(live.at(-1).id));
      });')"
  fi
  echo "Downloading OpenRS2 cache $id ..."
  mkdir -p "$cache_dir"
  curl -sf -A "$ua" -o "$cache_dir/disk.zip" "https://archive.openrs2.org/caches/runescape/$id/disk.zip"
  (cd "$cache_dir" && unzip -q -o disk.zip && rm disk.zip)
  echo "$id" > "$cache_dir/openrs2-id"
fi

java_home="${JAVA_HOME:-$(command -v mise >/dev/null && mise where java@temurin-17 2>/dev/null || true)}"
if [[ -z "$java_home" ]]; then
  echo "Set JAVA_HOME to a JDK 17 install" >&2
  exit 1
fi

cd "$repo"
JAVA_HOME="$java_home" ./gradlew -q -p agent-engine/kb-dumper run \
  -Dorg.gradle.java.installations.paths="$java_home" \
  --args="$cache_dir/cache $out_dir" 2>&1 | grep -v "revision mismatch" || true
test -f "$out_dir/manifest.json"
