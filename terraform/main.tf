# SatGraph production infrastructure.
#
# Only the data resources live here; the scheduler Worker and the Pages site
# are deployed by the CD pipeline with wrangler. There is a single production
# environment, so this root module is applied once.
#
# Usage:
#   export CLOUDFLARE_API_TOKEN=...        # token with D1 + KV edit rights
#   terraform init
#   terraform apply -var="cloudflare_account_id=<account id>"
#
# Afterwards copy `terraform output` values into wrangler.toml and
# apps/scheduler/wrangler.toml.

terraform {
  required_version = ">= 1.6"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

provider "cloudflare" {
  # Authenticates with the CLOUDFLARE_API_TOKEN environment variable.
}

resource "cloudflare_d1_database" "satgraph" {
  account_id = var.cloudflare_account_id
  name       = "satgraph"
}

resource "cloudflare_workers_kv_namespace" "satgraph" {
  account_id = var.cloudflare_account_id
  title      = "satgraph-kv"
}
