terraform {
  # 桶名、对象键、区域和 S3 端点在 init 时注入；凭据只从环境读取。
  backend "s3" {
    encrypt                     = true
    use_path_style              = true
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
  }
}
