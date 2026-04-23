DAR                   := .daml/dist/example-0.0.1.dar
JSON_API_PORT         := 6864
LEDGER_API_PORT       := 6865
ADMIN_API_PORT        := 6866
SEQUENCER_PUBLIC_PORT := 6867
SEQUENCER_ADMIN_PORT  := 6868
MEDIATOR_ADMIN_PORT   := 6869
PORT_FILE             := sandbox.ports

.PHONY: help up down reset build sandbox wait init clean

help:
	@echo "make up     — build, start sandbox, bootstrap ledger state"
	@echo "make down   — stop sandbox"
	@echo "make reset  — down + up (clean slate)"
	@echo "make clean  — remove build artifacts"

up: build sandbox wait init
	@echo ""
	@echo "  → ready. sandbox:  http://127.0.0.1:$(JSON_API_PORT)"
	@echo "  → try:             cnwla --profile alice whoami"
	@echo "  → sandbox logs:    tail -f sandbox.log"

build:
	dpm build

sandbox:
	@if [ -f sandbox.pid ] && kill -0 $$(cat sandbox.pid) 2>/dev/null; then \
	  echo "sandbox already running (pid $$(cat sandbox.pid)). make down first."; exit 1; \
	fi
	@rm -f $(PORT_FILE) sandbox.pid
	@echo "starting sandbox..."
	@dpm sandbox \
	  --json-api-port $(JSON_API_PORT) \
	  --ledger-api-port $(LEDGER_API_PORT) \
	  --admin-api-port $(ADMIN_API_PORT) \
	  --sequencer-public-port $(SEQUENCER_PUBLIC_PORT) \
	  --sequencer-admin-port $(SEQUENCER_ADMIN_PORT) \
	  --mediator-admin-port $(MEDIATOR_ADMIN_PORT) \
	  --canton-port-file $(PORT_FILE) \
	  --dar $(DAR) > sandbox.log 2>&1 &
	@# dpm is a launcher that forks java and exits; match ^java specifically
	@# so we don't accidentally capture the short-lived dpm wrapper's pid
	@for i in 1 2 3 4 5 6 7 8 9 10; do \
	  pid=$$(pgrep -f "^java .*canton-enterprise.*--json-api-port $(JSON_API_PORT)" 2>/dev/null | head -1); \
	  if [ -n "$$pid" ]; then echo $$pid > sandbox.pid; break; fi; \
	  sleep 1; \
	done
	@if [ ! -f sandbox.pid ]; then \
	  echo "✗ sandbox java process not found after 10s. log tail:"; tail -20 sandbox.log; exit 1; \
	fi
	@echo "  sandbox pid: $$(cat sandbox.pid)"

wait:
	@echo "waiting for synchronizer to come up (watching $(PORT_FILE))..."
	@pid=$$(cat sandbox.pid); \
	while [ ! -s $(PORT_FILE) ]; do \
	  if ! kill -0 $$pid 2>/dev/null; then \
	    echo ""; echo "✗ sandbox (pid $$pid) died before readiness. Last 20 log lines:"; \
	    tail -20 sandbox.log; \
	    rm -f sandbox.pid; \
	    exit 1; \
	  fi; \
	  sleep 1; \
	done
	@echo "sandbox fully ready."

init:
	@echo "running Setup:setup via Daml Script..."
	dpm script \
	  --dar $(DAR) \
	  --script-name Setup:setup \
	  --ledger-host 127.0.0.1 \
	  --ledger-port $(LEDGER_API_PORT)

down:
	@if [ -f sandbox.pid ]; then \
	  pid=$$(cat sandbox.pid); \
	  if kill -0 $$pid 2>/dev/null; then \
	    echo "stopping sandbox (pid $$pid)..."; \
	    kill $$pid 2>/dev/null || true; \
	    for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do \
	      kill -0 $$pid 2>/dev/null || break; \
	      sleep 1; \
	    done; \
	    if kill -0 $$pid 2>/dev/null; then \
	      echo "  SIGTERM timed out after 15s, sending SIGKILL"; \
	      kill -9 $$pid 2>/dev/null || true; \
	    fi; \
	  fi; \
	  rm -f sandbox.pid; \
	fi
	@# Belt & suspenders: kill anything still on our ports (orphaned java from prior runs)
	@for p in $(JSON_API_PORT) $(LEDGER_API_PORT) $(ADMIN_API_PORT) $(SEQUENCER_PUBLIC_PORT) $(SEQUENCER_ADMIN_PORT) $(MEDIATOR_ADMIN_PORT); do \
	  other=$$(ss -ltnp 2>/dev/null | grep -E ":$$p[[:space:]]" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2); \
	  if [ -n "$$other" ]; then \
	    echo "  port $$p held by pid $$other, killing"; \
	    kill -9 $$other 2>/dev/null || true; \
	  fi; \
	done
	@rm -f $(PORT_FILE)
	@echo "sandbox stopped."

reset: down up

clean:
	rm -rf .daml sandbox.log sandbox.pid $(PORT_FILE)
