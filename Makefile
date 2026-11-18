#
# Copyright 2026 The Buildish Authors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

.DEFAULT_GOAL := build

NPM ?= npm
PYTHON ?= python3
NODE_MODULES_STAMP := node_modules/.buildish-mammoth-cache-installed
BUILD_STAMP := dist/.buildish-mammoth-cache-built
BUILD_INPUTS := package.json tsconfig.json $(shell find src descriptors -type f 2>/dev/null)
DISTRIBUTION_ROOT ?= .
RELEASE_REPOSITORY ?= .
ARCHIVE_OUTPUT_DIR ?= build/release-archives
ARCHIVE_CONSUMER_NODE ?= node
HELP_TARGETS := $(MAKEFILE_LIST)

.PHONY: archive-consumer-check archive-consumer-test build check clean clean-all distribution-check help integration-test integration-test-build-reporting integration-test-distributed-reuse integration-test-gradle-distributed-reuse integration-test-maven-distributed-reuse integration-test-maven-repository-semantics lint-check lint-fix rat-check rebuild release-archives release-archives-test release-launcher-test release-legal-check release-legal-incompatible-license-check release-tooling-qualification release-workflow-test sanity-check smoke-test test versioned-docs-test zizmor-check

help: ## Show available Make targets.
	@awk 'BEGIN {FS = ":.*## "; printf "Available targets:\n"} /^[a-zA-Z0-9_.-]+:.*## / {printf "  %-12s %s\n", $$1, $$2}' $(HELP_TARGETS)

sanity-check: ## Verify the active node and npm versions match the project expectations.
	@command -v node >/dev/null 2>&1 || { \
		echo "Error: node is not available on PATH. Run 'nvm use' first."; \
		exit 1; \
	}
	@command -v $(NPM) >/dev/null 2>&1 || { \
		echo "Error: $(NPM) is not available on PATH. Run 'nvm use' first."; \
		exit 1; \
	}
	@expected_node_version="$$(tr -d '[:space:]' < .nvmrc)"; \
	actual_node_version="$$(node --version | sed 's/^v//')"; \
	if [ "$$actual_node_version" != "$$expected_node_version" ]; then \
		echo "Error: expected node $$expected_node_version but found $$actual_node_version. Run 'nvm use' first."; \
		exit 1; \
	fi
	@expected_npm_version="$$(node scripts/resolve-npm-version.mjs)"; \
	actual_npm_version="$$($(NPM) --version)"; \
	if [ "$$actual_npm_version" != "$$expected_npm_version" ]; then \
		echo "Error: expected npm $$expected_npm_version but found $$actual_npm_version. Provision npm as documented in docs/dev/contributing.md."; \
		exit 1; \
	fi

$(NODE_MODULES_STAMP): package.json package-lock.json
	$(NPM) ci
	@mkdir -p $(dir $@)
	@touch $@

$(BUILD_STAMP): $(NODE_MODULES_STAMP) $(BUILD_INPUTS)
	$(NPM) run build
	@mkdir -p $(dir $@)
	@touch $@

clean: sanity-check ## Remove generated build outputs.
	$(NPM) run clean

clean-all: clean ## Remove build outputs, node_modules, and legacy lib outputs.
	rm -rf lib node_modules

build: sanity-check $(BUILD_STAMP) ## Perform an incremental-friendly build.

rebuild: clean build ## Perform a fresh rebuild from a clean workspace.

test: build ## Run unit tests after ensuring the project is built.
	$(NPM) run test
	$(MAKE) versioned-docs-test release-archives-test archive-consumer-test release-launcher-test release-workflow-test

versioned-docs-test: ## Test docs maintenance in disposable Git repositories (Python 3.11+, Bash, Git).
	$(PYTHON) -B -m unittest discover -s test -p 'versioned_docs_test.py' -v

release-archives-test: ## Test unsigned archive packaging against disposable Git commits (uses the existing Node dependencies).
	$(PYTHON) -B -m unittest discover -s test -p 'release_archives_test.py' -v

archive-consumer-test: ## Test archive consumer orchestration and cleanup without running or downloading Gradle.
	$(PYTHON) -B -m unittest discover -s test -p 'archive_consumer_test.py' -v

release-launcher-test: ## Test the exact installed-package launcher using disposable metadata fixtures; does not install tooling.
	$(PYTHON) -B -m unittest discover -s test -p 'release_launcher_test.py' -v

release-workflow-test: ## Test release transport, approval and evidence boundaries without credentials/network.
	$(PYTHON) -B -m unittest discover -s test -p 'release_workflow_test.py' -v

release-tooling-qualification: build ## Qualify an already installed 0.1.4 wheel with real bundles and disposable Git/state fixtures; no signing/publication.
	@test -n "$${BUILDISH_RELEASE_TOOLING_PYTHON:-}" || { echo 'Set BUILDISH_RELEASE_TOOLING_PYTHON to an approved installed interpreter (absolute path).'; exit 1; }
	$(PYTHON) -B -m unittest discover -s test -p 'release_tooling_qualification_test.py' -v

archive-consumer-check: build ## Package real built bundles in disposable S/M commits and smoke-test the unpacked ZIP (can download Gradle).
	$(PYTHON) -B scripts/archive-consumer-check.py --node "$(ARCHIVE_CONSUMER_NODE)"

release-archives: sanity-check ## Package exact SOURCE_COMMIT and MATERIALIZED_COMMIT for RELEASE_VERSION into a new ARCHIVE_OUTPUT_DIR; no build/sign/publish.
	$(PYTHON) -B scripts/package-release.py --repository "$(RELEASE_REPOSITORY)" \
		--source-commit "$(SOURCE_COMMIT)" --materialized-commit "$(MATERIALIZED_COMMIT)" \
		--version "$(RELEASE_VERSION)" --output-dir "$(ARCHIVE_OUTPUT_DIR)"

lint-check: sanity-check $(NODE_MODULES_STAMP) ## Run linting and formatting checks.
	$(NPM) run lint
	$(NPM) run format

lint-fix: sanity-check $(NODE_MODULES_STAMP) ## Automatically fix lint issues and rewrite formatting.
	$(NPM) exec eslint -- . --fix
	$(NPM) run format:write

rat-check: sanity-check ## Run Apache RAT license-header verification (requires Java 21+).
	$(NPM) run rat-check

zizmor-check: ## Run Zizmor GitHub Actions security analysis (requires zizmor on PATH; install via: cargo install zizmor).
	@command -v zizmor >/dev/null 2>&1 || { \
		echo "Error: zizmor is not available on PATH."; \
		echo "Install it with: cargo install zizmor"; \
		exit 1; \
	}
	zizmor .

release-legal-incompatible-license-check: sanity-check $(NODE_MODULES_STAMP) ## Apply the provisional incompatible-license gate to bundled dependencies.
	$(NPM) run release-legal:check-incompatible-licenses

release-legal-check: sanity-check $(NODE_MODULES_STAMP) ## Verify legal/github/LICENSE and legal/github/NOTICE for the GitHub action distribution.
	$(NPM) run release-legal:check

release-legal-write: sanity-check $(NODE_MODULES_STAMP) ## Generate legal/github/LICENSE and legal/github/NOTICE for the GitHub action distribution.
	$(NPM) ci --ignore-scripts
	$(NPM) run release-legal:write
	$(NPM) run release-legal:check

distribution-check: sanity-check ## Validate and smoke-test an existing Action tree (DISTRIBUTION_ROOT defaults to .); does not build it.
	$(NPM) run smoke-test -- --distribution-root "$(DISTRIBUTION_ROOT)"

smoke-test: build ## Build, validate, and smoke-test both Actions' main/post bundles in isolation.
	$(NPM) run smoke-test

integration-test: build ## Run all local integration tests via Vitest (requires Java 21+; mvn also required for the Maven test).
	INTEGRATION_TESTS=1 $(NPM) exec -- vitest run --reporter=verbose --project integration

integration-test-build-reporting: build ## Run the local multi-build Gradle build-reporting integration test.
	INTEGRATION_TESTS=1 $(NPM) exec -- vitest run --reporter=verbose test/integration/build-reporting.test.ts

integration-test-gradle-distributed-reuse: build ## Run the local worker/aggregator Gradle distributed-reuse integration test.
	INTEGRATION_TESTS=1 $(NPM) exec -- vitest run --reporter=verbose test/integration/gradle-distributed-reuse.test.ts

integration-test-maven-distributed-reuse: build ## Run the local worker/aggregator Maven distributed-reuse integration test (requires mvn on PATH).
	INTEGRATION_TESTS=1 $(NPM) exec -- vitest run --reporter=verbose test/integration/maven-distributed-reuse.test.ts

integration-test-maven-repository-semantics: build ## Test Maven origin tracking with the installed Resolver (requires mvn, javac, java, and GNU tar; no public remotes).
	INTEGRATION_TESTS=1 $(NPM) exec -- vitest run --reporter=verbose test/integration/maven-repository-semantics.test.ts

integration-test-distributed-reuse: ## Run the local worker/aggregator Gradle + Maven distributed-reuse integration tests (requires mvn on PATH).
	$(MAKE) integration-test-gradle-distributed-reuse
	$(MAKE) integration-test-maven-distributed-reuse

check: ## Run a full clean verification: clean-all, build, test, lint-check, provisional license checks, and rat-check.
	$(MAKE) clean-all
	$(MAKE) build
	$(MAKE) test
	$(MAKE) lint-check
	$(MAKE) release-legal-incompatible-license-check
	$(MAKE) rat-check
