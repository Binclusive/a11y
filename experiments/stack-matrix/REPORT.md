# Stack-Matrix — cross-stack a11y-checker measurement

Cold-scan recall of the a11y-checker across **20** OSS React repos spanning **8** design systems × **4** frameworks (4 errored). Out-of-the-box: no `init`, no manual declarations.

## Matrix — one row per repo

| repo | framework | designSystem | files | checked | trusted | declare | findings | blocking | topRule |
|---|---|---|---|---:|---:|---:|---:|---:|---|
| jolbol1/jolly-ui | next | reactAria | 706 | 88 | 80 | 325 | 315 | 315 | enforce/input-no-name |
| untitleduico/react | next | reactAria | 297 | 43 | 63 | 424 | 174 | 174 | jsx-a11y/anchor-is-valid |
| umijs/umi | react | antd | 427 | 13 | 50 | 176 | 162 | 162 | jsx-a11y/anchor-is-valid |
| Supernova3339/changerawr | next | headlessui | 214 | 40 | 77 | 174 | 142 | 142 | enforce/button-no-name |
| jaiarobotics/jaiabot | react | mui | 114 | 5 | 21 | 118 | 87 | 87 | jsx-a11y/click-events-have-key-events |
| DarkInventor/easy-ui | next | radix | 174 | 27 | 51 | 105 | 57 | 57 | enforce/button-no-name |
| alibaba/lowcode-demo | react | antd | 82 | 0 | 0 | 21 | 15 | 15 | jsx-a11y/alt-text |
| shadcn-ui/taxonomy | next | radix | 94 | 31 | 104 | 67 | 14 | 14 | jsx-a11y/heading-has-content |
| iamzhihuix/skills-manage | react-router | baseui | 49 | 11 | 0 | 83 | 12 | 12 | jsx-a11y/click-events-have-key-events |
| thomasgauvin/claude-agent-sdk-in-cloudflare-containers | react-router | baseui | 6 | 0 | 0 | 12 | 8 | 8 | jsx-a11y/label-has-associated-control |
| hathora/builder | react | headlessui | 26 | 0 | 5 | 20 | 7 | 7 | jsx-a11y/alt-text |
| antiwork/shortest | next | reactAria | 25 | 9 | 12 | 22 | 4 | 4 | jsx-a11y/role-has-required-aria-props |
| modagavr/pancake-wizard | vite-react | headlessui | 5 | 0 | 2 | 6 | 3 | 3 | enforce/dialog-no-name |
| vikejs/bati | react | mantine | 47 | 0 | 9 | 27 | 3 | 3 | jsx-a11y/click-events-have-key-events |
| BoringBoredom/UEFI-Editor | vite-react | mantine | 8 | 0 | 23 | 7 | 2 | 2 | jsx-a11y/click-events-have-key-events |
| corbt/agent.exe | react-router | chakra | 3 | 3 | 5 | 3 | 2 | 2 | enforce/button-no-name |
| steven-tey/precedent | next | radix | 22 | 2 | 11 | 25 | 1 | 1 | jsx-a11y/anchor-has-content |
| agarun/turborepo-vite-starter | react-router | mui | 8 | 0 | 3 | 6 | 0 | 0 | - |
| kamp-us/phoenix | react-router | baseui | 49 | 2 | 0 | 107 | 0 | 0 | - |
| mantinedev/vite-template | react-router | mantine | 7 | 0 | 5 | 6 | 0 | 0 | - |

## Coverage grid — design system × framework (repo count)

| designSystem | next | react | react-router | vite-react | total |
|---|---:|---:|---:|---:|---:|
| antd | 0 | 2 | 0 | 0 | 2 |
| baseui | 0 | 0 | 3 | 0 | 3 |
| chakra | 0 | 0 | 1 | 0 | 1 |
| headlessui | 1 | 1 | 0 | 1 | 3 |
| mantine | 0 | 1 | 1 | 1 | 3 |
| mui | 0 | 1 | 1 | 0 | 2 |
| radix | 3 | 0 | 0 | 0 | 3 |
| reactAria | 3 | 0 | 0 | 0 | 3 |

## Rollup — by design system

| designSystem | repos | totalFindings | medianDeclare | dominant rule families |
|---|---:|---:|---:|---|
| antd | 2 | 177 | 99 | jsx-a11y/anchor-is-valid (57), jsx-a11y/click-events-have-key-events (44), jsx-a11y/no-static-element-interactions (38) |
| baseui | 3 | 20 | 83 | jsx-a11y/label-has-associated-control (10), jsx-a11y/click-events-have-key-events (5), jsx-a11y/no-static-element-interactions (4) |
| chakra | 1 | 2 | 3 | enforce/button-no-name (2) |
| headlessui | 3 | 152 | 20 | enforce/button-no-name (66), jsx-a11y/click-events-have-key-events (25), jsx-a11y/no-static-element-interactions (25) |
| mantine | 3 | 5 | 7 | jsx-a11y/click-events-have-key-events (3), jsx-a11y/no-static-element-interactions (2) |
| mui | 2 | 87 | 62 | jsx-a11y/click-events-have-key-events (38), jsx-a11y/no-static-element-interactions (38), jsx-a11y/alt-text (7) |
| radix | 3 | 72 | 67 | enforce/button-no-name (35), jsx-a11y/heading-has-content (18), jsx-a11y/anchor-is-valid (6) |
| reactAria | 3 | 493 | 325 | jsx-a11y/anchor-is-valid (190), enforce/input-no-name (125), enforce/button-no-name (105) |

## Rollup — by framework

| framework | repos | totalFindings | medianDeclare | dominant rule families |
|---|---:|---:|---:|---|
| next | 7 | 707 | 105 | enforce/button-no-name (206), jsx-a11y/anchor-is-valid (202), enforce/input-no-name (134) |
| react | 5 | 274 | 27 | jsx-a11y/click-events-have-key-events (85), jsx-a11y/no-static-element-interactions (78), jsx-a11y/anchor-is-valid (57) |
| react-router | 6 | 22 | 9 | jsx-a11y/label-has-associated-control (10), jsx-a11y/click-events-have-key-events (5), jsx-a11y/no-static-element-interactions (4) |
| vite-react | 2 | 5 | 7 | enforce/dialog-no-name (2), jsx-a11y/label-has-associated-control (1), jsx-a11y/click-events-have-key-events (1) |

## Signal — single-rule clusters (likely false-positive / next-hardening targets)

Repos where one ruleId accounts for the bulk of findings — worth a human look:

| repo | dominant rule | count / total | share |
|---|---|---:|---:|
| untitleduico/react | jsx-a11y/anchor-is-valid | 105 / 174 | 60% |
| DarkInventor/easy-ui | enforce/button-no-name | 35 / 57 | 61% |
| shadcn-ui/taxonomy | jsx-a11y/heading-has-content | 9 / 14 | 64% |
| thomasgauvin/claude-agent-sdk-in-cloudflare-containers | jsx-a11y/label-has-associated-control | 8 / 8 | 100% |

## Errored repos

| repo | designSystem | error |
|---|---|---|
| creativetimofficial/purity-ui-dashboard | chakra | no .tsx files found in clone |
| guangqiang-liu/OneM | antd | no .tsx files found in clone |
| horizon-ui/horizon-ui-chakra | chakra | no .tsx files found in clone |
| rickypeng99/yugioh_web | mui | no .tsx files found in clone |

