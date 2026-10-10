# Security

The band stores readings (context, cost, rate limits, the cache clock, running subagent types) in session state; see "What it can reach" in the README. It makes no network requests. It runs two processes: a `tail` of this session's own transcript when loaded mid-session, and the `costCommand` you configure.

If you find a way it could leak data, please report it privately through GitHub's **Security → Report a vulnerability** on this repository rather than in a public issue.
