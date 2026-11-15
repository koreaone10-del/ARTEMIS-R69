#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
pkg update -y
pkg install nodejs-lts git unzip -y
printf '\nARTEMIS R69 dependencies installed.\n'
printf 'Next: cd into the project folder and run npm install && npm start\n'
