// =============================================
// FILE: rust/src/test_cron.rs
// PURPOSE: standalone test utility for cron schedule logic.
// DESCRIPTION: This small binary is used to manually verify the behavior of the 
// `cron` crate and ensures the logic used in `include_exclude_cron` for second-level 
// matching is correct.
// =============================================

use cron::Schedule;
use std::str::FromStr;
use chrono::{Utc, Duration};

fn main() {
    // Define a test cron expression that fires every 2 seconds
    let expr = "*/2 * * * * * *";
    // Parse the expression into a Schedule object
    let schedule = Schedule::from_str(expr).expect("invalid");
    
    // Get the current time as the starting point
    let now = Utc::now();
    println!("Now: {}", now);
    
    // Simulate the next 10 seconds to verify matching logic
    for i in 0..10 {
        // Calculate the simulated 'current' time
        let t = now + Duration::seconds(i);
        // Define the reference time for the 'after' check (one second in the past)
        let test_time = t - Duration::seconds(1);
        // Find the next scheduled fire time relative to the reference time
        let mut upcoming = schedule.after(&test_time);
        let next = upcoming.next().unwrap();
        // Check if the next fire time matches our simulated 'current' second
        let matches = next.timestamp() == t.timestamp();
        
        println!("T+{}: {} | Next fire: {} | Matches: {}", i, t, next, matches);
    }
}
