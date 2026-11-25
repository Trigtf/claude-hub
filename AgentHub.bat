@echo off
pushd "%~dp0"
start "" "node_modules\electron\dist\electron.exe" .
popd
