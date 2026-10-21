# Eval report

Brain: scripted (pipeline check) | Scenarios passed: **7/7**

Checks on every agent turn: no clock time that was not offered, one question at most, bubble length and count, no long dash, no private calendar title. On every created event: valid email, tied to the lead phone, no overlap with existing meetings.

| scenario | brain | turns | result |
|---|---|---|---|
| happy_path: Lead explains the need, gives name and company, picks a slot with email | scripted | 4 | pass |
| pick_without_email: Lead picks a slot before giving an email: no booking until the email arrives | scripted | 5 | pass |
| invalid_email: A broken email is rejected, never used in an invite | scripted | 4 | pass |
| asks_for_human: Asking for a human hands over and silences the agent | scripted | 2 | pass |
| cancel_own_meeting: Books, then cancels with an explicit confirmation | scripted | 6 | pass |
| english: English conversation end to end | scripted | 4 | pass |
| rogue_model: A model that tries to book without data, invents a time, asks two questions and uses a long dash. The code must hold. | rogue | 2 | pass |

## Transcript: happy_path

> **Lead:** Oi, quero organizar o processo de vendas da minha empresa
> **Agent:** Entendi. Com quem eu falo?
>
> **Lead:** Sou o Carlos
> **Agent:** Prazer! De qual empresa você é?
>
> **Lead:** Sou da Contoso
> **Agent:** Faz sentido a gente conversar.
> **Agent:** Tenho quarta-feira, 21 de outubro às 15:30 ou quinta-feira, 22 de outubro às 09:00. Qual fica melhor?
>
> **Lead:** Pode ser o primeiro, carlos@contoso.com
> **Agent:** Agendado para quarta-feira, 21 de outubro às 15:30. O convite chega no seu e-mail.
>

## Transcript: rogue_model

> **Lead:** Oi
> **Agent:** Com quem eu falo?
> _code: dropped_unoffered_time, trimmed_extra_question, book_blocked_missing_name_
>
> **Lead:** quero marcar
> **Agent:** Com quem eu falo?
> _code: dropped_unoffered_time, trimmed_extra_question, book_blocked_missing_name_
>
