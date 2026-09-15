#!/bin/zsh
set -e
PROJECT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
APP_PATH="$PROJECT_DIR/release/mac-arm64/20张.app"
if [[ -d "$APP_PATH" ]]; then
  open "$APP_PATH"
else
  print '没有找到已打包的应用。请参考 README.md 运行 npm install 和 npm start。'
  read '?按回车关闭'
fi
