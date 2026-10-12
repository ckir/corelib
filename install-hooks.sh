#!/usr/bin/env bash
# =============================================
# FILE: install-hooks.sh
# PURPOSE: Install lefthook git hooks for Corelib Monorepo
# Run: ./install-hooks.sh (or make install-hooks)
# =============================================

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Detect OS
IS_WINDOWS=false
if [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]] || [[ -n "${WINDIR:-}" ]]; then
  IS_WINDOWS=true
fi

echo -e "${BLUE}=========================================${NC}"
echo -e "${BLUE}  Corelib Monorepo - Git Hooks Installer${NC}"
echo -e "${BLUE}=========================================${NC}"
echo ""

# Check if we're in a git repository
if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo -e "${RED}❌ Error: Not in a git repository${NC}"
  exit 1
fi

# Check if lefthook is available
if ! command -v lefthook &> /dev/null; then
  echo -e "${YELLOW}⚠️  lefthook not found in PATH${NC}"
  
  # Try to install globally via npm
  if command -v npm &> /dev/null; then
    echo -e "${BLUE}📦 Installing lefthook globally via npm...${NC}"
    npm install -g lefthook@1.13.6 || {
      echo -e "${RED}❌ Failed to install lefthook via npm${NC}"
      echo -e "${YELLOW}   Please install lefthook manually:${NC}"
      echo -e "${YELLOW}   - macOS: brew install lefthook${NC}"
      echo -e "${YELLOW}   - Linux: curl -sSfL https://raw.githubusercontent.com/evilmartians/lefthook/master/install.sh | sh${NC}"
      echo -e "${YELLOW}   - Windows: scoop install lefthook${NC}"
      exit 1
    }
  else
    echo -e "${RED}❌ npm not found. Please install lefthook manually:${NC}"
    echo -e "${YELLOW}   - macOS: brew install lefthook${NC}"
    echo -e "${YELLOW}   - Linux: curl -sSfL https://raw.githubusercontent.com/evilmartians/lefthook/master/install.sh | sh${NC}"
    echo -e "${YELLOW}   - Windows: scoop install lefthook${NC}"
    exit 1
  fi
fi

echo -e "${GREEN}✅ lefthook found: $(lefthook version)${NC}"

# Install git hooks
echo -e "${BLUE}🔧 Installing git hooks...${NC}"
if lefthook install; then
  echo -e "${GREEN}✅ Git hooks installed successfully${NC}"
else
  echo -e "${RED}❌ Failed to install git hooks${NC}"
  exit 1
fi

# Verify hooks were created
echo -e "${BLUE}🔍 Verifying installed hooks...${NC}"
HOOKS_DIR=".git/hooks"
EXPECTED_HOOKS=("pre-commit" "pre-push")
ALL_OK=true

for hook in "${EXPECTED_HOOKS[@]}"; do
  if [[ -f "${HOOKS_DIR}/${hook}" ]]; then
    echo -e "${GREEN}  ✅ ${hook}${NC}"
  else
    echo -e "${RED}  ❌ ${hook} (missing)${NC}"
    ALL_OK=false
  fi
done

if [[ "$ALL_OK" = true ]]; then
  echo ""
  echo -e "${GREEN}=========================================${NC}"
  echo -e "${GREEN}  All hooks installed successfully! 🎉${NC}"
  echo -e "${GREEN}=========================================${NC}"
  echo ""
  echo -e "${BLUE}Installed hooks:${NC}"
  echo -e "  • ${YELLOW}pre-commit${NC}: Runs format-all + lint-all (fast, <30s)"
  echo -e "  • ${YELLOW}pre-push${NC}: Runs build-all + test-all:run (heavy gate)"
  echo ""
  echo -e "${BLUE}API/Type change detection:${NC}"
  echo -e "  • If you modify **/*types.ts, *.d.ts, or */src/index.ts"
  echo -e "  • A warning will appear reminding you to run typecheck"
  echo ""
  echo -e "${BLUE}To bypass hooks (not recommended):${NC}"
  echo -e "  • git commit --no-verify"
  echo -e "  • git push --no-verify"
  echo ""
else
  echo ""
  echo -e "${RED}=========================================${NC}"
  echo -e "${RED}  Some hooks failed to install${NC}"
  echo -e "${RED}=========================================${NC}"
  exit 1
fi

# Verify lefthook.yml exists
if [[ -f "lefthook.yml" ]]; then
  echo -e "${GREEN}✅ lefthook.yml found${NC}"
else
  echo -e "${YELLOW}⚠️  lefthook.yml not found in repo root${NC}"
fi

# Offer to run a quick verification
echo -e "${BLUE}💡 Run 'pnpm verify:fast' to test the pre-commit hook locally${NC}"
echo -e "${BLUE}💡 Run 'pnpm verify:full' to test the pre-push hook locally${NC}"