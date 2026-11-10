output "d1_database_id" {
  description = "D1 database ID backing the SATGRAPH_DB binding (resolved automatically by the CD pipeline)."
  value       = cloudflare_d1_database.satgraph.id
}

output "kv_namespace_id" {
  description = "KV namespace ID backing the SATGRAPH_KV binding (resolved automatically by the CD pipeline)."
  value       = cloudflare_workers_kv_namespace.satgraph.id
}
