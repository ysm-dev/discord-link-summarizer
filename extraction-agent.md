---
description: Reads public links and writes Korean summaries using safe extraction tools
mode: primary
hidden: true
model: opencode-go/gpt-6-luna#max
permissions:
  - action: "*"
    resource: "*"
    effect: deny
  - action: read
    resource: "*"
    effect: allow
  - action: read
    resource: "*.env"
    effect: deny
  - action: read
    resource: "*.env.*"
    effect: deny
  - action: webfetch
    resource: "*"
    effect: allow
  - action: websearch
    resource: "*"
    effect: allow
  - action: summarizer_extract_page
    resource: "*"
    effect: allow
  - action: summarizer_extract_youtube
    resource: "*"
    effect: allow
---
