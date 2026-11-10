output "d1_database_id" {
  description = "D1 database ID for the SATGRAPH_DB binding in both wrangler.toml files."
  value       = cloudflare_d1_database.satgraph.id
}

output "kv_namespace_id" {
  description = "KV namespace ID for the SATGRAPH_KV binding in both wrangler.toml files."
  value       = cloudflare_workers_kv_namespace.satgraph.id
}
