// Host stand-in for nvs_flash.h. prov_store.c includes it but never calls into
// it — bringing the flash partition up is provisioning.c's job, and that file is
// not part of the host suite.
#pragma once

#include "nvs.h"
