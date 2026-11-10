# SatGraph production infrastructure.
#
# Only the data resources live here; the scheduler Worker and the Pages site
# are deployed by the CD pipeline with wrangler. There is a single production
# environment, so this root module is applied once by the terraform pipeline.
#
# State lives in an R2 bucket created once as a bootstrap step; the CD
# pipeline resolves the resource IDs from the Cloudflare API, so no manual
# copy of the outputs into wrangler.toml is needed.

terraform {
  required_version = ">= 1.6"

  backend "s3" {}

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
