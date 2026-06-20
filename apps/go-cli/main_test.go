package main

import "testing"

func TestShouldWaitDefaultsToTrue(t *testing.T) {
	opts, rest, err := parseTaskOptions(nil, nil)
	if err != nil {
		t.Fatalf("parseTaskOptions returned error: %v", err)
	}
	if len(rest) != 0 {
		t.Fatalf("expected no rest args, got %v", rest)
	}
	if !shouldWait(opts) {
		t.Fatal("expected task commands to wait by default")
	}
}

func TestShouldWaitHonorsNoWait(t *testing.T) {
	opts, _, err := parseTaskOptions([]string{"--no-wait"}, nil)
	if err != nil {
		t.Fatalf("parseTaskOptions returned error: %v", err)
	}
	if shouldWait(opts) {
		t.Fatal("expected --no-wait to disable waiting")
	}
}

func TestShouldWaitOutOverridesNoWait(t *testing.T) {
	opts, _, err := parseTaskOptions([]string{"--no-wait", "--out", "result.pdf"}, nil)
	if err != nil {
		t.Fatalf("parseTaskOptions returned error: %v", err)
	}
	if !shouldWait(opts) {
		t.Fatal("expected --out to wait so the completed task output can be saved")
	}
}
