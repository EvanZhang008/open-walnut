// The Walnut Connect library for a build made without Rust's iOS targets (build-apple.sh):
// the same functions, each saying this build has no Walnut Connect. The app then lists no
// Walnut Connect route and pairs as before. A TestFlight or App Store build refuses the stub
// (build-apple.sh WALNUT_CONNECT_REQUIRE=1).
#include <stdlib.h>
#include <string.h>
#include "walnut_connect.h"

static char *copy(const char *s) {
    size_t n = strlen(s) + 1;
    char *out = malloc(n);
    if (out) memcpy(out, s, n);
    return out;
}

static const char *NONE = "{\"ok\":false,\"stub\":true,\"error\":\"this build of the app has no Walnut Connect\"}";

char *wc_start(const char *config_json) { (void)config_json; return copy(NONE); }
char *wc_status(void) { return copy("{\"ok\":true,\"running\":false,\"stub\":true}"); }
char *wc_connect(void) { return copy(NONE); }
void wc_network_changed(void) {}
void wc_stop(void) {}
char *wc_endpoint_id(const char *key_hex) { (void)key_hex; return copy(NONE); }
void wc_free(char *s) { free(s); }
