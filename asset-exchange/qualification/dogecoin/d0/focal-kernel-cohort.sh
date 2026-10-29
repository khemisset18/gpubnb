#!/usr/bin/env bash
# Shared by build, installed-package smoke and snapshot discovery. These are
# KunNw0n requirements, coherent with the existing microcode/expat pins.
# slightlyskepticalpotat has an OLDER kernel AND older microcode/expat; mixing
# variants is forbidden. Neither this helper nor the probe changes trust inputs.
# Callback receives package and expected version; any failure stops the cohort.
check_focal_kernel_cohort() {
  local checker="$1"
  "$checker" linux-image-generic "5.4.0.202.198" || return 1
  "$checker" linux-image-5.4.0-202-generic "5.4.0-202.222" || return 1
  "$checker" linux-modules-5.4.0-202-generic "5.4.0-202.222" || return 1
  "$checker" linux-modules-extra-5.4.0-202-generic "5.4.0-202.222" || return 1
  "$checker" linux-libc-dev "5.4.0-202.222" || return 1
}
