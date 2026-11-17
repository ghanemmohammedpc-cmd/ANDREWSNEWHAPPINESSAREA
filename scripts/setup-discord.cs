using System;
using System.Drawing;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;

class DiscordSetup : Form {
    readonly TextBox secret = new TextBox();
    readonly TextBox owner = new TextBox();
    readonly string file = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "..", ".env"));
    DiscordSetup() {
        Text = "Team Razka Program - Discord setup";
        ClientSize = new Size(610, 360);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        Font = new Font("Segoe UI", 10);
        AddLabel("Paste the Client Secret from your application's OAuth2 page.\nIt is saved privately on this PC.", 24, 20, 560, 45);
        AddLabel("OAuth Client Secret", 24, 78, 560, 24);
        secret.SetBounds(24, 105, 560, 28);
        secret.UseSystemPasswordChar = true;
        Controls.Add(secret);
        AddLabel("Your Discord user ID (optional, for owner access)", 24, 145, 560, 24);
        owner.SetBounds(24, 172, 560, 28);
        Controls.Add(owner);
        AddLabel("Add this URL under OAuth2 > Redirects in the Developer Portal:", 24, 215, 560, 24);
        var redirect = new TextBox { Text = "http://127.0.0.1:8787/api/v1/auth/discord/callback", ReadOnly = true };
        redirect.SetBounds(24, 243, 560, 28);
        Controls.Add(redirect);
        var save = new Button { Text = "Save" };
        save.SetBounds(459, 303, 125, 34);
        save.Click += Save;
        Controls.Add(save);
        AcceptButton = save;
    }
    void AddLabel(string value, int x, int y, int width, int height) {
        var label = new Label { Text = value };
        label.SetBounds(x, y, width, height);
        Controls.Add(label);
    }
    static string SetValue(string text, string key, string value) {
        string pattern = "(?m)^" + Regex.Escape(key) + "=[^\\r\\n]*";
        return Regex.IsMatch(text, pattern) ? Regex.Replace(text, pattern, key + "=" + value) : text + "\r\n" + key + "=" + value + "\r\n";
    }
    void Save(object sender, EventArgs args) {
        if (!Regex.IsMatch(secret.Text.Trim(), "^[A-Za-z0-9_-]{24,200}$")) {
            MessageBox.Show(this, "Enter the Client Secret from OAuth2, not the bot token.", "Discord setup"); return;
        }
        if (owner.Text.Trim().Length > 0 && !Regex.IsMatch(owner.Text.Trim(), "^[0-9]{15,22}$")) {
            MessageBox.Show(this, "The Discord user ID must contain only digits.", "Discord setup"); return;
        }
        try {
            string text = SetValue(File.ReadAllText(file), "DISCORD_CLIENT_SECRET", secret.Text.Trim());
            if (owner.Text.Trim().Length > 0) text = SetValue(text, "ADMIN_DISCORD_IDS", owner.Text.Trim());
            File.WriteAllText(file, text, new UTF8Encoding(false));
            secret.Clear();
            MessageBox.Show(this, "Saved. Return to Team Razka Program.", "Discord setup");
            Close();
        } catch { MessageBox.Show(this, "The private configuration could not be saved.", "Discord setup"); }
    }
    [STAThread]
    static void Main() {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new DiscordSetup());
    }
}
