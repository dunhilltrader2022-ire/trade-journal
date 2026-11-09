#!/bin/sh
# Rebuild the cockpit page from dev/src and copy it, with the rules engine, into ../server.
set -e
cd "$(dirname "$0")"
mkdir -p dist
python3 - <<'PY'
page = open('src/page.html').read()
rules = open('src/rules.js').read() + '\n' + open('src/sample.js').read()
app = open('src/app.js').read() + '\n' + open('src/feed.js').read()
for name, js in (('rules', rules), ('app', app)):
    assert '</script' not in js.lower(), name + ' contains a closing script tag'
open('dist/cockpit.html', 'w').write(page.replace('/*__RULES__*/', rules).replace('/*__APP__*/', app))
print('built dist/cockpit.html')
PY
cp src/rules.js ../server/lib/rules.js
cp dist/cockpit.html ../server/public/index.html
echo 'copied into ../server — rebuild the container with: docker compose up -d --build'
