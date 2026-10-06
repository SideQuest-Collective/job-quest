EXP = {
 "sr": ["Designed a billing service of 4 components that handles 2M+ events per day.",
        "Cut P99 latency from 900ms to 300ms by adding a cache layer."],
 "ii": ["Moved a nightly batch job to Step Functions, saving $40K per year."],
 "i":  ["Built an internal dashboard "
        "used by 3 teams."],
}
PANTRY = ("Pantry", "React Native, TypeScript, Supabase",
 ["Built a recipe planner app as a solo project on a Supabase (PostgreSQL) backend."])
RELAY = ("Relay", "TypeScript, Node.js",
 ["Built a bridge that forwards team chat messages to email.",
  "Added automated tests and CI on GitHub Actions."])
V = {
"Base": dict(head="Senior Software Engineer | Backend & Data",
 summary="Backend engineer with 6+ years building data services on AWS.",
 skills=[("Languages","Python, TypeScript, SQL"),("Cloud","AWS (Lambda, S3, SQS), Docker"),("Practices",r"CI/CD, Code Review")]),
}
V["Other"]=dict(V["Base"])
V["Other"]["head"]="Platform Engineer | AWS"
