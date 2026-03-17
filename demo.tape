# stealth-cli Demo
Output demo.gif

Set Shell "bash"
Set FontSize 14
Set Width 1000
Set Height 550
Set Theme "Catppuccin Mocha"
Set Padding 15
Set TypingSpeed 35ms

# 1. Browse a real website
Type "stealth browse https://news.ycombinator.com"
Enter
Sleep 12s

# 2. Search DuckDuckGo
Type "stealth search duckduckgo 'anti-detection browser' -f json | head -15"
Enter
Sleep 12s

# 3. Screenshot
Type "stealth screenshot https://github.com -o github.png"
Enter
Sleep 10s

# 4. Extract links
Type "stealth extract https://news.ycombinator.com --links -f json | head -20"
Enter
Sleep 12s

Sleep 2s
