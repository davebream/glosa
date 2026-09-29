use framework "Foundation"
use scripting additions
on run argv
  set sourceURL to current application's NSURL's fileURLWithPath:(item 1 of argv)
  set manager to current application's NSFileManager's defaultManager()
  set {didTrash, resultingURL, failure} to manager's trashItemAtURL:sourceURL resultingItemURL:(reference) |error|:(reference)
  if didTrash as boolean then
    return "OK " & (resultingURL's |path|() as text)
  else
    return "ERR " & (failure's code() as text)
  end if
end run
