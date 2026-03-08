fd --unrestricted --type directory dist --exec rip -f
fd --unrestricted --type directory node_modules --exec rip -f
fd --unrestricted --type directory docs --exec rip -f
fd --unrestricted --type file Cargo.lock --exec rip -f
fd --unrestricted --type file pnpm-lock.yaml --exec rip -f
fd --unrestricted --type file corelib.txt --exec rip -f
