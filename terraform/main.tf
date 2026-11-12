# SateGraph production infrastructure.
#
# Only the data resources live here; the scheduler Worker and the Pages site
# are deployed by the CD pipeline with wrangler. There is a single production
# environment, so this root module is applied once by the terraform pipeline.
#
# State lives in the B2 bucket below, created once as a bootstrap step; the CD
# pipeline resolves the resource IDs from the Cloudflare API, so no manual
# copy of the outputs into wrangler.toml is needed.

terraform {
  required_version = ">= 1.9"

  # Backblaze B2 state bucket (S3-compatible); the skip flags are required
  # because B2 does not implement the corresponding AWS APIs.
  backend "s3" {
    bucket = "sategraph-tfstate"
    key    = "terraform.tfstate"
    region = "us-east-005"

    endpoints = {
      s3 = "https://s3.us-east-005.backblazeb2.com"
    }

    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    use_path_style              = true
  }

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

resource "cloudflare_d1_database" "sategraph" {
  account_id = var.cloudflare_account_id
  name       = "sategraph"
}

resource "cloudflare_workers_kv_namespace" "sategraph" {
  account_id = var.cloudflare_account_id
  title      = "sategraph-kv"
}

# Protects POST /api/v1/agent/chat from abuse. The API verifies the token with
# the widget secret (TURNSTILE_SECRET); Workers AI itself needs no resource —
# it is an account capability bound through the [ai] wrangler binding.
resource "cloudflare_turnstile_widget" "agent" {
  account_id = var.cloudflare_account_id
  name       = "sategraph-agent"
  domains    = ["sategraph.pages.dev"]
  mode       = "managed"
  region     = "world"
}
