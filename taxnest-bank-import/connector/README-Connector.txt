TaxNest Tally Connector
=======================
A small Windows app that lets the TaxNest Bank Import website load your ledgers from Tally and push entries into it.
It shows whether Tally is connected and which company is open.

1. Open Tally and open your company. Make sure Tally's XML/ODBC server is ON (port 9000):
   Tally Prime : F1 (Help) > Settings > Connectivity > Client/Server configuration > "TallyPrime acts as: Both / Server", port 9000.
   Tally ERP 9 : F12 Configure > Advanced Configuration > "Tally.ERP 9 is acting as: Both", port 9000.
2. Double-click  "TaxNest Connector.bat"  - the TaxNest Connector window opens.
   (Windows may say "Windows protected your PC" because the app is not code-signed: choose More info > Run anyway.)
3. Open the TaxNest Bank Import website. The Tally light turns green and shows your company name; ledgers sync automatically.
4. The first time, Windows asks "Allow <website> to use the connector?" - click Yes.

Closing the window sends it to the system tray (near the clock); right-click the tray icon > Exit connector to stop it.
Nothing is installed. To remove it, exit the connector and delete this folder (and %APPDATA%\TaxNestConnector).
Your data stays on your computer: the connector only talks to your browser and to Tally.

Chrome/Edge may ask "Allow this site to access devices on your local network?" - click Allow (this is the same connection).

If the window does not open: use "Start-TaxNest-Connector.bat" instead (the classic black-window version of the same connector).
If the light stays red: is Tally open with a company loaded? Is the connector still running? Is port 9000 enabled in Tally?
