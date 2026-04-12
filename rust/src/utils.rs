// =============================================
// FILE: rust/src/utils.rs
// PURPOSE: Utils module index / barrel file
// DESCRIPTION: Re-exports all helper utilities, mirroring the TypeScript 
// `ts-core/src/utils/index.ts` structure.
// =============================================

/// Dedicated cron helper (exact mirror of TS `includeExcludeCron`).
/// Provides flexible inclusion and exclusion rules for task scheduling.
pub mod include_exclude_cron;

// Re-export the public API so users can write:
// use corelib_rust::utils::{include_exclude_cron, CronJobHandle};

/// High-level function to run a callback on a schedule with inclusion/exclusion filters.
pub use include_exclude_cron::include_exclude_cron;
/// Handle returned by the cron scheduler to manage or stop the task.
pub use include_exclude_cron::CronJobHandle;
