#!/bin/sh

IFS= read -r command
printf '[{"type":"list_files","cmd":"%s","path":"ccodex"}]\n' "$command"
