# Deyao's Cloudflare account as code, so far its Access organisation (team de0ch): OpenTofu, applied in the cluster by
# Flux tofu-controller (k8s/cloudflare/terraform.yaml; README "Cloudflare (tofu)"). Git is the truth: a change here is
# planned and applied on push, and every 30 minutes a plan reverts what was changed in the dashboard. State: Secret
# services/tfstate-default-cloudflare.
terraform {
  required_version = ">= 1.8"
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare", version = "5.28.1" }
  }
}

variable "cloudflare_api_token" {
  type      = string
  sensitive = true # Secret services/cloudflare-api = CF_ACCESS_ORG_TOKEN (token deyao-access-org: Access Organizations Write+Read)
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

locals {
  account = "ee3b4deef856baf11e1a67b242438325"
}
