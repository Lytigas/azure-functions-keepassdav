SHELL := bash
.ONESHELL:
.SHELLFLAGS := -eu -o pipefail -c
.DELETE_ON_ERROR:
MAKEFLAGS += --warn-undefined-variables
MAKEFLAGS += --no-builtin-rules

serve:
	watchexec --watch FlatDav --restart $(MAKE) serve_restart
.PHONY: serve

serve_restart:
	func host start
.PHONY: serve_restart

localstack_up:
	docker-compose up -d
.PHONY: localstack_up

localstack_down:
	docker compose down
.PHONY: localstack_down

create_bucket: localstack_up
	aws --endpoint-url=http://localhost:4572 s3 mb s3://flatdav-test-bucket
.PHONY: create_bucket
