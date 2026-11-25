terraform {
  required_version = ">= 1.7, < 2.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.13.0"
    }
  }
}

provider "cloudflare" {}

resource "cloudflare_d1_database" "core" {
  account_id = var.account_id
  name       = "sategraph-${var.environment}-core"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_turnstile_widget" "access" {
  account_id = var.account_id
  name       = "sategraph-${var.environment}-access"
  mode       = "managed"
  domains    = [var.public_hostname]
}
