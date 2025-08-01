# WordPress Data Extractor

This is a Node.js command-line application that connects to a WordPress site using the REST API to fetch data about all posts, pages, and custom post types (CPTs). It extracts metadata including title, author, dates, and available Yoast SEO data, then saves the output as a CSV report.

## Prerequisites

1.  **Node.js**: You must have Node.js installed on your machine (v16 or higher is recommended).
2.  **WordPress Site**: The target WordPress site must be accessible online.
3.  **Application Password**: You need to generate an **Application Password** in your WordPress user profile.
    * Log in to your WordPress admin dashboard.
    * Go to **Users** -> **Profile**.
    * Scroll down to the "Application Passwords" section.
    * Enter a name for the new application (e.g., "Data Extractor Script") and click "Add New Application Password".
    * **Important**: Copy the generated password immediately. You will not be able to see it again. This is the password you will use in the script, not your main login password.

## How to Use

### 1. Setup

Clone or download the files (`package.json`, `index.js`, `README.md`) into a new folder. Open your terminal or command prompt and navigate into that folder.

Install the required dependencies by running:

```bash
npm install
```

### 2. Run the Script

Execute the script with the following command:

```bash
npm start
```
or
```bash
node index.js
```

### 3. Provide Credentials

The script will interactively prompt you for the following information:
- Your WordPress site domain (e.g., `your-website.com`, without `https://`)
- Your WordPress username.
- The Application Password you generated earlier.

### 4. Output

The script will display its progress in the terminal as it fetches data. Once complete, it will create a new folder structure and save a CSV report inside it.

The path will be: `reports/<your-domain>/<datetime>-yoast-report.csv`

For example: `reports/your-website.com/2025-08-01T21-55-00-123Z-yoast-report.csv`

