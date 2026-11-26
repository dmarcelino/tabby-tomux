## ADDED Requirements

### Requirement: Empty tmux version reply is retried once
When the `tmux -V` check closes its channel with no output while the SSH session is still alive, tomux SHALL run the check once more on a new channel of the same SSH session and SHALL log a warning naming the first attempt's diagnostics. tomux SHALL NOT retry any other failure of the check: a timeout, a refused exec request, output that is not from tmux, a tmux older than the minimum, or an SSH session destroyed during the check.

#### Scenario: Second attempt answers
- **WHEN** the first `tmux -V` closes with no output and the second prints a supported tmux version
- **THEN** the connection opens as normal and the log has a warning with the first attempt's diagnostics

#### Scenario: Second attempt fails too
- **WHEN** the first `tmux -V` closes with no output and the second attempt also fails
- **THEN** the tomux tab shows the "no usable tmux" error with the second attempt's diagnostics followed by the first attempt's, and no control connection is kept open

#### Scenario: SSH session destroyed during the check
- **WHEN** `tmux -V` closes with no output and the SSH session was destroyed while it ran
- **THEN** tomux does not run it again and the tomux tab shows the "no usable tmux" error

### Requirement: Empty tmux version reply names its diagnostics
When `tmux -V` closes with no output, the error SHALL name the text the channel received on stderr, whether EOF arrived, how long the channel lived after the exec request, and whether the SSH session was destroyed while the check ran.

#### Scenario: Session destroyed before the channel closed
- **WHEN** the SSH session is destroyed and then the `tmux -V` channel closes with no output
- **THEN** the error ends with `SSH session destroyed: yes`, after the stderr text, the EOF state and the channel lifetime

### Requirement: Version check gives up in time
The `tmux -V` check SHALL fail within its time limit (10 seconds) even when the SSH channel for it never opens or the exec request never answers. A channel that opens after the check gave up SHALL be closed.

#### Scenario: Channel never opens
- **WHEN** the SSH channel for `tmux -V` does not open within the time limit
- **THEN** the check fails with "did not answer in time", the tomux tab shows the "no usable tmux" error, and a channel that opens later is closed
