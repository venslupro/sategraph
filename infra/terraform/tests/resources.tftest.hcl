mock_provider "cloudflare" {}

variables {
  account_id      = "00000000000000000000000000000000"
  environment     = "dev"
  public_hostname = "sategraph.example.test"
  existing_services = {
    b2_bucket_id   = "000000000000000000000000"
    neo4j_origin   = "https://fixture.databases.neo4j.io"
    neo4j_database = "neo4j"
  }
}

run "resource_contract" {
  command = plan

  assert {
    condition     = cloudflare_d1_database.core.name == "sategraph-dev-core" && cloudflare_turnstile_widget.access.mode == "managed" && contains(cloudflare_turnstile_widget.access.domains, var.public_hostname)
    error_message = "D1 命名或 Turnstile 作用域不符合约定。"
  }
}

run "reject_wildcard" {
  command = plan
  variables {
    public_hostname = "*.example.test"
  }
  expect_failures = [var.public_hostname]
}

run "reject_embedded_credentials" {
  command = plan
  variables {
    existing_services = {
      b2_bucket_id   = "000000000000000000000000"
      neo4j_origin   = "https://user:password@fixture.databases.neo4j.io"
      neo4j_database = "neo4j"
    }
  }
  expect_failures = [var.existing_services]
}
