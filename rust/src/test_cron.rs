use cron::Schedule;
use std::str::FromStr;
use chrono::{DateTime, Utc, Duration};

fn main() {
    let expr = "*/2 * * * * * *";
    let schedule = Schedule::from_str(expr).expect("invalid");
    
    let now = Utc::now();
    println!("Now: {}", now);
    
    for i in 0..10 {
        let t = now + Duration::seconds(i);
        let test_time = t - Duration::seconds(1);
        let mut upcoming = schedule.after(&test_time);
        let next = upcoming.next().unwrap();
        let matches = next <= t + Duration::seconds(1);
        println!("T+{}: {} | Next fire: {} | Matches: {}", i, t, next, matches);
    }
}
