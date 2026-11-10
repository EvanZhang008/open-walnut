// A test browser's own pasteboard on macOS (2026-11-10: headless WebKit wrote the Mac's real
// clipboard from a paste spec and replaced what the person had copied). Loaded into the
// Playwright WebKit process with DYLD_INSERT_LIBRARIES (tests/e2e/browser/pw-pasteboard.ts), it
// hands every request for the general pasteboard a private named one instead, so copy, cut, paste
// and the async clipboard API all work inside the run and never reach the person's clipboard.
// The private pasteboard is released when the process exits.
#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

static NSString *privateName, *privateFind;
static IMP origNamed;

static NSPasteboard *board(NSString *name) {
  return ((NSPasteboard * (*)(id, SEL, NSString *))origNamed)([NSPasteboard class], @selector(pasteboardWithName:), name);
}
static NSPasteboard *privateBoard(void) { return board(privateName); }

static NSPasteboard *walnutGeneral(id self, SEL _cmd) { return privateBoard(); }

// The general pasteboard (the clipboard) and the find pasteboard (Cmd+E) are the person's; drag
// pasteboards are per drag and stay as they are.
static NSPasteboard *walnutNamed(id self, SEL _cmd, NSString *name) {
  if (name == nil || [name isEqualToString:NSPasteboardNameGeneral]) return privateBoard();
  if ([name isEqualToString:NSPasteboardNameFind]) return board(privateFind);
  return ((NSPasteboard * (*)(id, SEL, NSString *))origNamed)(self, _cmd, name);
}

static void releaseBoard(void) { @autoreleasepool { [privateBoard() releaseGlobally]; [board(privateFind) releaseGlobally]; } }

__attribute__((constructor)) static void walnutPrivatePasteboard(void) {
  @autoreleasepool {
    const char *tag = getenv("WALNUT_PW_PASTEBOARD_NAME");
    privateName = [[NSString alloc] initWithFormat:@"%s-%d", (tag && *tag) ? tag : "walnut-test-pasteboard", getpid()];
    privateFind = [[NSString alloc] initWithFormat:@"%@-find", privateName];
    Class meta = object_getClass([NSPasteboard class]);
    Method named = class_getClassMethod([NSPasteboard class], @selector(pasteboardWithName:));
    Method general = class_getClassMethod([NSPasteboard class], @selector(generalPasteboard));
    if (!named || !general) return;
    origNamed = method_getImplementation(named);
    class_replaceMethod(meta, @selector(pasteboardWithName:), (IMP)walnutNamed, method_getTypeEncoding(named));
    class_replaceMethod(meta, @selector(generalPasteboard), (IMP)walnutGeneral, method_getTypeEncoding(general));
    atexit(releaseBoard);
    // Proof for the runner that the redirect is in place in this process.
    const char *mark = getenv("WALNUT_PW_PASTEBOARD_MARK");
    if (mark && *mark) { FILE *f = fopen(mark, "w"); if (f) { fprintf(f, "%s\n", privateName.UTF8String); fclose(f); } }
  }
}
