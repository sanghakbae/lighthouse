#!/bin/bash
# Lighthouse 분석 서버 실행 래퍼 (LaunchAgent에서 호출)
# nvm node를 로드해 버전이 바뀌어도 동작하도록 함
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

cd "$(dirname "$0")" || exit 1
export PORT=4567
exec node server.js
