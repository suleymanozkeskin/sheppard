#import <Foundation/Foundation.h>
#import <Speech/Speech.h>

static void Fail(NSString *code) {
    NSData *data = [[code stringByAppendingString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding];
    [[NSFileHandle fileHandleWithStandardError] writeData:data];
    exit(1);
}

static BOOL WaitForSignal(dispatch_semaphore_t semaphore, NSDate *deadline) {
    while ([deadline timeIntervalSinceNow] > 0) {
        if (dispatch_semaphore_wait(semaphore, DISPATCH_TIME_NOW) == 0) return YES;
        [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode
                              beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
    return dispatch_semaphore_wait(semaphore, DISPATCH_TIME_NOW) == 0;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 3) Fail(@"invalid-request");

        NSString *audioPath = [NSString stringWithUTF8String:argv[1]];
        NSString *localeIdentifier = [NSString stringWithUTF8String:argv[2]];
        if (audioPath == nil || localeIdentifier == nil) Fail(@"invalid-request");

        __block SFSpeechRecognizerAuthorizationStatus authorizationStatus =
            SFSpeechRecognizer.authorizationStatus;
        if (authorizationStatus == SFSpeechRecognizerAuthorizationStatusNotDetermined) {
            dispatch_semaphore_t authorizationReady = dispatch_semaphore_create(0);
            [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
                authorizationStatus = status;
                dispatch_semaphore_signal(authorizationReady);
            }];
            if (!WaitForSignal(authorizationReady, [NSDate dateWithTimeIntervalSinceNow:60])) {
                Fail(@"permission-timeout");
            }
        }
        if (authorizationStatus != SFSpeechRecognizerAuthorizationStatusAuthorized) {
            Fail(@"permission-denied");
        }

        NSLocale *locale = [[NSLocale alloc] initWithLocaleIdentifier:localeIdentifier];
        SFSpeechRecognizer *recognizer = [[SFSpeechRecognizer alloc] initWithLocale:locale];
        if (recognizer == nil) Fail(@"locale-unsupported");
        if (!recognizer.supportsOnDeviceRecognition) Fail(@"local-recognition-unavailable");

        NSURL *audioURL = [NSURL fileURLWithPath:audioPath];
        SFSpeechURLRecognitionRequest *request =
            [[SFSpeechURLRecognitionRequest alloc] initWithURL:audioURL];
        request.requiresOnDeviceRecognition = YES;
        request.shouldReportPartialResults = NO;
        if (@available(macOS 13.0, *)) request.addsPunctuation = YES;

        dispatch_semaphore_t recognitionReady = dispatch_semaphore_create(0);
        __block NSString *finalTranscript = nil;
        __block NSString *recognitionFailure = nil;
        SFSpeechRecognitionTask *task = [recognizer
            recognitionTaskWithRequest:request
                         resultHandler:^(SFSpeechRecognitionResult *result, NSError *error) {
            if (result != nil) {
                NSString *transcript =
                    [result.bestTranscription.formattedString
                        stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
                if (transcript.length > 0) finalTranscript = transcript;
                if (result.final) dispatch_semaphore_signal(recognitionReady);
                return;
            }
            if (error != nil) {
                recognitionFailure = [NSString stringWithFormat:@"recognition-failed:%@:%ld:%@",
                    error.domain,
                    (long)error.code,
                    error.localizedDescription];
                dispatch_semaphore_signal(recognitionReady);
            }
        }];

        if (!WaitForSignal(recognitionReady, [NSDate dateWithTimeIntervalSinceNow:75])) {
            [task cancel];
            Fail(@"recognition-timeout");
        }
        if (finalTranscript.length == 0) {
            Fail(recognitionFailure ?: @"no-speech");
        }

        [[NSFileHandle fileHandleWithStandardOutput]
            writeData:[finalTranscript dataUsingEncoding:NSUTF8StringEncoding]];
    }
    return 0;
}
