# Deyao's Cloudflare account as code, so far its Access organisation (team de0ch): OpenTofu, applied by the GitHub
# workflow .github/workflows/cloudflare.yml (README "Cloudflare (tofu)"). Git is the truth: a change here is planned and
# applied on push, and every 30 minutes a run reverts what was changed in the dashboard. State: R2 (below).
terraform {
  required_version = ">= 1.10"
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare", version = "5.28.1" }
  }
  # State in R2 on Deyao's account (bucket deyao-tofu-state; token deyao-tofu-state, R2 read+write on this account only:
  # DEYAO_TOFU_R2_ACCESS_KEY_ID / _SECRET_ACCESS_KEY). The lock is a lockfile beside it (S3 conditional writes).
  backend "s3" {
    bucket                      = "deyao-tofu-state"
    key                         = "services/cloudflare/terraform.tfstate"
    region                      = "auto"
    endpoints                   = { s3 = "https://ee3b4deef856baf11e1a67b242438325.r2.cloudflarestorage.com" }
    use_lockfile                = true
    use_path_style              = true
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
  }
}

variable "cloudflare_api_token" {
  type      = string
  sensitive = true # Actions secret CF_ACCESS_ORG_TOKEN (token deyao-access-org: Access Organizations Write+Read)
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

locals {
  account = "ee3b4deef856baf11e1a67b242438325"
}
