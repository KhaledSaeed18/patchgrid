# Remote state for every root but the bootstrap, which creates the bucket and
# the lock table this names: `tofu init -backend-config=../backend.hcl`.
bucket         = "patchgrid-local-tfstate"
region         = "us-east-1"
dynamodb_table = "patchgrid-local-tflock"
encrypt        = true
use_path_style = true

access_key                  = "test"
secret_key                  = "test"
skip_credentials_validation = true
skip_metadata_api_check     = true
skip_region_validation      = true
skip_requesting_account_id  = true

endpoints = {
  s3       = "http://localhost:4566"
  dynamodb = "http://localhost:4566"
}
