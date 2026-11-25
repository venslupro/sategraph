variable "account_id" {
  description = "Cloudflare 账户 ID；令牌由环境变量注入。"
  type        = string

  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.account_id))
    error_message = "账户 ID 须为 32 位小写十六进制。"
  }
}

variable "environment" {
  description = "环境名；不同环境必须使用独立的 state。"
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "环境须为 dev、staging 或 prod。"
  }
}

variable "public_hostname" {
  description = "工作台实际主机名，不含通配符、协议或路径。"
  type        = string

  validation {
    condition = length(var.public_hostname) <= 253 && can(regex(
      "^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.public_hostname
    ))
    error_message = "请填写完整的小写 DNS 主机名。"
  }
}

variable "existing_services" {
  description = "手工创建的私有 B2 桶 ID、Aura HTTPS 源站和数据库名；不能传密钥。"
  type = object({
    b2_bucket_id   = string
    neo4j_origin   = string
    neo4j_database = string
  })

  validation {
    condition = (
      can(regex("^[a-f0-9]{24}$", var.existing_services.b2_bucket_id)) &&
      can(regex("^https://[a-z0-9-]+\\.databases\\.neo4j\\.io$", var.existing_services.neo4j_origin)) &&
      can(regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$", var.existing_services.neo4j_database))
    )
    error_message = "请填写有效的桶 ID、Aura HTTPS 源站与数据库名；不接受密码、查询串或目录。"
  }
}
