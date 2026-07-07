# What's Left — one-command lifecycle.
# Works on Linux/macOS/WSL/Git Bash. On plain Windows PowerShell use the
# underlying npm scripts (they are 1:1 with these targets).

SHELL := bash
.DEFAULT_GOAL := help

.PHONY: help setup test dev dev-web build dist smoke verify clean

help: ## list targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-10s %s\n", $$1, $$2}'

setup: ## install deps + electron binary (fresh clone → ready)
	npm ci
	node node_modules/electron/install.js
	npm run sqlite:electron

test: ## full gates: sqlite→node ABI, vitest, typecheck
	npm run sqlite:node
	npx vitest run
	npm run typecheck

dev: ## run the desktop app (flips sqlite to electron ABI first)
	npm run sqlite:electron
	npm run dev

dev-web: ## renderer-only browser preview with demo data (:5173)
	npm run dev:web

build: ## production bundles (no installer)
	npm run build

dist: test ## installer for THIS OS (nsis/AppImage/dmg) — gates first
	npm run sqlite:electron
	npm run dist

smoke: ## prove Plaid sandbox keys work (.secrets/plaid-sandbox.json or env)
	node scripts/plaid-sandbox-smoke.mjs

verify: test build ## everything CI would run

clean: ## remove build output + release artifacts
	rm -rf out release
