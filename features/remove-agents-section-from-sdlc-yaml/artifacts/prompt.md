Remove the agents section from SDLC.yaml and validation, as I've added the agent step a few times and forgot to include it in this section.
It is redundand.

sdlc:
  agents:
    - prepare-environment
    - implementation-plan
    - implementation
    - merge
    - cleanup-environment