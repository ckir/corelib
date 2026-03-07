Remove-Item "corelib.txt" -ErrorAction SilentlyContinue
dir-to-text --use-gitignore -e docs -e "target" -e "Cargo.lock" -e .git -e *.lock -e pnpm-lock.yaml .
