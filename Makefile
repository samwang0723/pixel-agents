.PHONY: build build-ext build-standalone start stop clean

PORT ?= 7891
CWD ?= $(shell pwd)

## Build everything (extension + webview + standalone server)
build: build-ext build-standalone

build-ext:
	npm run compile

build-standalone:
	cd standalone && npm install --silent
	node standalone/build.js

## Start standalone server (builds first if needed)
start: build
	@lsof -t -i:$(PORT) | xargs kill 2>/dev/null || true
	@echo "Starting Pixel Agents at http://localhost:$(PORT)"
	node dist/standalone/server.js --cwd "$(CWD)" --port $(PORT)

## Stop the server
stop:
	@lsof -t -i:$(PORT) | xargs kill 2>/dev/null && echo "Stopped" || echo "Not running"

## Install all dependencies
install:
	npm install
	cd webview-ui && npm install
	cd standalone && npm install

## Clean build artifacts
clean:
	rm -rf dist
