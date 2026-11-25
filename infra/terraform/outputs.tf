output "bindings" {
  description = "供后续 Wrangler 配置消费的非机密标识；不管理 Worker 或 Pages。"
  value = {
    account_id         = var.account_id
    environment        = var.environment
    d1_database_id     = cloudflare_d1_database.core.id
    d1_database_name   = cloudflare_d1_database.core.name
    turnstile_site_key = cloudflare_turnstile_widget.access.sitekey
    public_hostname    = var.public_hostname
    existing_services  = var.existing_services
  }
}
