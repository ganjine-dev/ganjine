#!/bin/sh
# Rebuilds the ganjine_demo database with one page using every block kind. Never touches the real database.
set -eu
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
docker compose -f deploy/docker-compose.yml exec -T postgres psql -U ganjine -d ganjine -q \
  -c 'DROP DATABASE IF EXISTS ganjine_demo WITH (FORCE)' -c 'CREATE DATABASE ganjine_demo'
export GANJINE_DATABASE_URL=postgres://ganjine:ganjine@localhost:5434/ganjine_demo
export GANJINE_BLOB_DIR="$root/.ganjine/demo-blobs"
id() { sed -n 's/.*"id": "\(.*\)",*/\1/p' | head -1; }

./ganjine db migrate >/dev/null
./ganjine item create example >/dev/null
./ganjine category create demo >/dev/null
./ganjine category create examples --parent demo >/dev/null
./ganjine category attach example demo/examples >/dev/null
series=$(./ganjine record put --kind demo.series --item example \
  --payload '{"values":[{"d":"2026-10-01","v":100},{"d":"2026-10-08","v":112},{"d":"2026-10-15","v":107},{"d":"2026-10-22","v":121},{"d":"2026-10-29","v":118}]}' | id)
timeline=$(python3 -c "
import json,math,datetime as d
s=d.date(2025,10,29)
print(json.dumps({'source':'synthetic demo data','values':[{'date':str(s+d.timedelta(7*i)),'series':n,'value':round(100+i*k+6*math.sin(i/4+p),2)} for i in range(53) for n,k,p in (('Alpha',.8,0),('Beta',.3,2),('Benchmark',.5,4))]}))")
stored=$(./ganjine series put --item example --payload "$timeline" --steps 26 --exclude Benchmark)
line=$(echo "$stored" | sed -n 's/.*"record": "\(.*\)".*/\1/p')
guess=$(echo "$stored" | sed -n 's/.*"forecast": "\(.*\)".*/\1/p')
rows=$(./ganjine record put --kind demo.rows --item example --payload '{"rows":[["alpha",3],["beta",12],["gamma",7]]}' | id)
blob=$(./ganjine blob put framework/demo/embed.html | sed -n 's/.*"ref": "\(.*\)"/\1/p')

page() { # as_of summary delta
  cat <<JSON | ./ganjine page put - >/dev/null
{"contract_version":2,"address":"/items/example/overview","as_of":"$1",
 "produced_by":{"agent":"demo"},"inputs_used":["$series","$rows","$line","$guess"],"summary":"$2",
 "blocks":[
  {"kind":"kv","items":[{"key":"Value","value":"118","unit":"units","delta":$3},{"key":"Inputs","value":"2"}]},
  {"kind":"markdown","text":"Rendered **as of $1**. Every block kind appears below.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nRaw HTML is ignored: <b>not bold</b>"},
  {"kind":"chart","id":"series","title":"Series","spec":{"mark":{"type":"line","point":true},"height":220,"encoding":{"x":{"field":"d","type":"temporal","title":null},"y":{"field":"v","type":"quantitative","title":null,"scale":{"zero":false}}}},"data":{"record":"$series"}},
  {"kind":"timeline","title":"The standard chart","data":{"record":"$line"},"forecast":{"record":"$guess"},"reference":["Benchmark"]},
  {"kind":"table","title":"Inline table (sortable)","columns":[{"name":"name","type":"string"},{"name":"value","type":"number"}],"rows":[["one",10],["two",2],["three",null]]},
  {"kind":"table","title":"Table from a record","columns":[{"name":"name","type":"string"},{"name":"value","type":"number"}],"record":"$rows"},
  {"kind":"embed","blob":"$blob","height":200,"title":"Sandboxed embed"},
  {"kind":"ref","address":"/items/example/overview","as_of":"2026-10-08"},
  {"kind":"ref","address":"/items/example/missing"}
 ]}
JSON
}
page 2026-10-08 "First look" 12
page 2026-10-29 "Latest look" -3

echo "Demo ready. Open it with:"
echo "  GANJINE_DATABASE_URL=$GANJINE_DATABASE_URL GANJINE_BLOB_DIR=$GANJINE_BLOB_DIR ./ganjine serve --port 4401"
echo "  then http://127.0.0.1:4401/pages/items/example/overview"
