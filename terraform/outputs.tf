output "d1_database_id" {
  description = "D1 database ID backing the SATEGRAPH_DB binding (resolved automatically by the CD pipeline)."
  value       = cloudflare_d1_database.sategraph.id
}

output "kv_namespace_id" {
  description = "KV namespace ID backing the SATEGRAPH_KV binding (resolved automatically by the CD pipeline)."
  value       = cloudflare_workers_kv_namespace.sategraph.id
}

output "turnstile_sitekey" {
  description = "Turnstile sitekey rendered by the web app when challenging agent requests."
  value       = cloudflare_turnstile_widget.agent.id
}

output "turnstile_secret" {
  description = "Turnstile widget secret; set it as TURNSTILE_SECRET on the Pages project."
  value       = cloudflare_turnstile_widget.agent.secret
  sensitive   = true
}
